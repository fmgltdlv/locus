/**
 * Ticket Hub - floating window (Manage Data-style) for searching, filtering,
 * stats, and a detailed view of tickets.
 */
'use strict';

    let hubDragging = false;
    let hubDragOffset = { x: 0, y: 0 };
    let hubResizing = false;
    let hubResizeType = null;
    let hubResizeStart = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0 };
    let selectedHubTicketId = null;
    /** Pending open from project detail (hydrate-on-miss): { ticketId, error?: string|null } */
    let hubPendingOpen = null;
    /** Multi-select for bulk actions (refresh, renew/remark, site documentation). */
    const hubBulkSelectedIds = new Set();
    let hubOutsideClickBound = false;
    /** After drag/resize, mouseup is often outside the hub; the following click would otherwise close it (timestamp ms). */
    let hubSuppressOutsideCloseUntil = 0;
    /** Desktop: dragging the list/detail split handle (percentage width of the list column). */
    let hubSplitDragging = false;
    let hubSplitStart = { x: 0, pct: 55 };
    /** Dragging a ticket hub table column boundary (pixel widths). */
    let hubColDragging = false;
    let hubColResizeStart = {
        x: 0,
        leftKey: null,
        rightKey: null,
        leftWidth: 0,
        rightWidth: 0,
        leftMin: 0,
        rightMin: 0,
    };
    const HUB_SPLIT_MIN_PCT = 28;
    const HUB_SPLIT_MAX_PCT = 72;
    const HUB_WINDOW_MIN_WIDTH = 640;
    const HUB_WINDOW_MIN_HEIGHT = 400;
    const HUB_WINDOW_MAX_WIDTH = 1720;
    const HUB_WINDOW_MAX_HEIGHT = 900;
    const HUB_WINDOW_VIEWPORT_GUTTER = 12;
    /** Status stat filters: combine Complete/Incomplete/Expiring (OR), or Live only, or Total (ALL) only. Default: Live. */
    let hubStatusFilters = new Set(['ACTIVE']);
    /** Partner-shared filter toggled from External stat chip (Organization dropdown deprecated). */
    let hubPartnerSharedFilter = false;

    /** GeoJSON Polygon drawn on map; tickets must intersect this area when set. */
    let hubSearchPolygonGeo = null;
    /** Cached L.Polygon for intersection tests (same geometry as hubSearchPolygonGeo). */
    let hubSearchPolygonLeaflet = null;
    /** Persistent preview layer on the map (optional class for styling). */
    let hubSearchPolygonMapLayer = null;
    /** If set, call when cancelling draw (Escape, close hub, etc.). */
    let hubPolygonDrawingCleanup = null;
    let hubPolygonDrawingFinish = null;
    /** True after we closed the hub to draw a search polygon; reopen on finish or cancel. */
    let hubTempClosedForPolygonDraw = false;

    /** Ticket Hub is available to all org roles, including tech (redacted UI). */
    function isTicketHubAccessible() {
        return true;
    }

    const STATUS_PRIORITY = {
        EXPIRING_SOON: 0,
        NOT_READY: 1,
        ACTION_REQUIRED: 2,
        READY: 3,
        EXPIRED: 4,
        CANCELLED: 4
    };

    function hubEscapeHtml(s) {
        if (s == null || s === '') return '';
        const d = document.createElement('div');
        d.textContent = String(s);
        return d.innerHTML;
    }

    /** Click targets may be Text nodes; they have no .closest - use nearest Element. */
    function clickTargetElement(ev) {
        const t = ev && ev.target;
        if (t == null) return null;
        return t.nodeType === 1 ? t : t.parentElement;
    }

    /**
     * Find the delegated hub action button. Uses composedPath so nested nodes (text, SVG,
     * spans) always resolve; stops at `panel` so we do not match ancestors outside the panel.
     */
    function hubActionButtonFromEvent(e, panel) {
        if (!e) return null;
        const boundary = panel || e.currentTarget;
        if (typeof e.composedPath === 'function') {
            const path = e.composedPath();
            for (let i = 0; i < path.length; i++) {
                const n = path[i];
                if (n === boundary) break;
                if (
                    n &&
                    n.nodeType === 1 &&
                    typeof n.hasAttribute === 'function' &&
                    n.hasAttribute('data-hub-action')
                ) {
                    return n;
                }
            }
        }
        const fromEl = clickTargetElement(e);
        if (!fromEl || !fromEl.closest) return null;
        const btn = fromEl.closest('[data-hub-action]');
        if (!btn) return null;
        if (boundary && !boundary.contains(btn)) return null;
        return btn;
    }

    function ticketImporter() {
        return window.ticketImporterModule;
    }

    /** Delegates to ticketImporter (shared with sidebar / map). */
    function normalizeHubTicketBase(tn) {
        const m = ticketImporter();
        if (m && typeof m.normalizeTicketBase === 'function') return m.normalizeTicketBase(tn);
        return String(tn || '').split('-')[0];
    }

    function parseTicketNumberPartsClient(ticket) {
        const m = ticketImporter();
        if (m && typeof m.parseTicketNumberParts === 'function') return m.parseTicketNumberParts(ticket);
        const raw = String((ticket && ticket.ticketNumber) || '').trim();
        if (!raw) return { baseNumber: '', revisionSuffix: null, displayFull: '' };
        const idx = raw.indexOf('-');
        if (idx === -1) return { baseNumber: raw, revisionSuffix: null, displayFull: raw };
        return {
            baseNumber: raw.slice(0, idx),
            revisionSuffix: raw.slice(idx + 1) || null,
            displayFull: raw
        };
    }

    /** Revision for display: max -XXX from stored suffix list, else NV API / stored row (ticketImporter). */
    function revisionLabelForTicket(ticket) {
        if (!ticket) return null;
        const m = ticketImporter();
        if (m && typeof m.resolveRevisionLabelForTicket === 'function') {
            const r = m.resolveRevisionLabelForTicket(ticket);
            if (r != null && String(r).trim() !== '') return String(r).trim();
        }
        const p = parseTicketNumberPartsClient(ticket);
        if (p.revisionSuffix != null && String(p.revisionSuffix).trim() !== '') {
            return String(p.revisionSuffix).trim();
        }
        if (ticket.ticketRevision != null && String(ticket.ticketRevision).trim() !== '') {
            return String(ticket.ticketRevision).trim();
        }
        return null;
    }

    function dedupeHubTicketsByBase(tickets) {
        const m = ticketImporter();
        if (m && typeof m.dedupeTicketsByBase === 'function') return m.dedupeTicketsByBase(tickets);
        return Array.isArray(tickets) ? tickets.slice() : [];
    }

    function isSharedHubTicket(ticket) {
        return !!(ticket && ticket.shared);
    }

    /**
     * Org-owned rows (including POSR / externalImportedToOrg) may be bulk-selected and deleted.
     * Partner shared-in tickets stay excluded.
     */
    function isHubTicketBulkSelectable(ticket) {
        return !!(ticket && !isSharedHubTicket(ticket));
    }

    function isHubTicketExternalForOrg(ticket) {
        if (ticket && ticket.__feedWorkspaceView) return true;
        const tm = window.ticketsModule;
        if (tm && typeof tm.isTicketExternalForOrg === 'function') return !!tm.isTicketExternalForOrg(ticket);
        return isSharedHubTicket(ticket);
    }

    function isHubTicketInternalForOrg(ticket) {
        const tm = window.ticketsModule;
        if (tm && typeof tm.isTicketInternalForOrg === 'function') return !!tm.isTicketInternalForOrg(ticket);
        return !isSharedHubTicket(ticket);
    }

    function getHubSharedSourceLabel(ticket) {
        if (!isSharedHubTicket(ticket)) return '';
        const label = ticket && ticket.sharedSourceLabel != null ? String(ticket.sharedSourceLabel).trim() : '';
        return label || 'Partner organization';
    }

    function getHubExternalBadgeHtml(ticket) {
        if (!isHubTicketExternalForOrg(ticket)) return '';
        if (isSharedHubTicket(ticket)) {
            const source = getHubSharedSourceLabel(ticket);
            return ` <span class="ticket-hub-shared-badge" title="Shared from ${hubEscapeHtml(source)}">External: ${hubEscapeHtml(source)}</span>`;
        }
        if (ticket && ticket.externalImportedToOrg) {
            return ' <span class="ticket-hub-shared-badge" title="Imported manually for this organization via POSR import">External</span>';
        }
        const lodgedBy = ticket && ticket.lodgedByUserName != null ? String(ticket.lodgedByUserName).trim() : '';
        const title = lodgedBy
            ? `Lodged by ${lodgedBy}, which is not a provider account in this organization`
            : 'Lodged by user is not a provider account in this organization';
        return ` <span class="ticket-hub-shared-badge" title="${hubEscapeHtml(title)}">External</span>`;
    }

    function formatTicketNumberCellHtml(ticket) {
        const parts = parseTicketNumberPartsClient(ticket);
        const base = parts.baseNumber || window.TICKET_HUB_TEXT.EM_DASH;
        const rev = revisionLabelForTicket(ticket);
        const sharedBadge = getHubExternalBadgeHtml(ticket);
        let numLine;
        if (rev != null && rev !== '') {
            numLine =
                `<span class="ticket-hub-ticket-num-line" title="Revision">` +
                `<span class="ticket-hub-tn-base">${hubEscapeHtml(base)}</span>` +
                `<span class="ticket-hub-tn-rev">-${hubEscapeHtml(rev)}</span>` +
                `</span>`;
        } else {
            const disp =
                (parts.displayFull && String(parts.displayFull).trim()) || base;
            numLine = `<span class="ticket-hub-ticket-num-line"><span class="ticket-hub-tn-base">${hubEscapeHtml(disp)}</span></span>`;
        }
        return numLine + sharedBadge;
    }

    function getSiblingTicketsByBase(ticket) {
        const base = normalizeHubTicketBase(ticket && ticket.ticketNumber);
        if (!base) return [];
        return (window.ORG_TICKETS || [])
            .filter(t => normalizeHubTicketBase(t.ticketNumber) === base)
            .sort((a, b) => {
                const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
                const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
                if (tb !== ta) return tb - ta;
                return String(b.ticketNumber || '').localeCompare(String(a.ticketNumber || ''));
            });
    }

    function closeTicketHistoryModal() {
        closeUtilityHistoryDetailModal();
        const el = document.getElementById('ticketHistoryModal');
        if (el) el.remove();
    }

    const TICKET_HISTORY_TAB_LOADING_HTML =
        '<div class="ticket-history-tab-panel-inner"><div class="ticket-history-block"><p class="ticket-history-modal-hint">Loading...</p></div></div>';

    const SYNC_LANE_POSR_PUBLIC = 'posr_public';

    /** NV public POSR/map import (`nv_api`, `nv_api_cache`, or `syncLane: posr_public`). */
    function isNvPublicImportTicket(ticket) {
        if (!ticket) return false;
        const src = ticket.source != null ? String(ticket.source).trim() : '';
        if (src === 'nv_api' || src === 'nv_api_cache') return true;
        const lane = ticket.syncLane != null ? String(ticket.syncLane).trim().toLowerCase() : '';
        return lane === SYNC_LANE_POSR_PUBLIC;
    }

    function ticketHistoryNeedsDbDetailHydration(ticket) {
        if (!ticket || !window.authModule || !window.authModule.isAuthenticated()) return false;
        const hasHistory = Array.isArray(ticket.history) && ticket.history.length > 0;
        const hasOperators = Array.isArray(ticket.operatorResponses) && ticket.operatorResponses.length > 0;
        if (isNvPublicImportTicket(ticket)) {
            return !hasHistory || !hasOperators;
        }
        if (ticket.listSummary === true && !hasOperators) {
            return true;
        }
        return false;
    }

    /** Lazy nGen GetNotificationResponseHistoryAsync — not used for NV public POSR imports. */
    function ticketHistoryNeedsNgenNotificationFetch(ticket) {
        if (!ticket || ticket.ticketNumber == null || String(ticket.ticketNumber).trim() === '') return false;
        if (!window.authModule || !window.authModule.isAuthenticated()) return false;
        if (isNvPublicImportTicket(ticket)) return false;
        const isNgen =
            (typeof window.isNgenPrimarySyncedTicket === 'function' && window.isNgenPrimarySyncedTicket(ticket)) ||
            (ticket.ngenJobNumber != null && String(ticket.ngenJobNumber).trim() !== '');
        if (!isNgen) return false;
        const hasJob =
            (typeof window.getUsanEnquiryIdFromTicket === 'function' &&
                window.getUsanEnquiryIdFromTicket(ticket) != null) ||
            (ticket.ngenJobNumber != null && String(ticket.ngenJobNumber).trim() !== '');
        if (!hasJob) return false;
        if (ticket.ngenResponseHistoryStatus === 'unavailable' || ticket.ngenResponseHistoryStatus === 'error') {
            return false;
        }

        const history = ticket.providerResponseHistory || ticket.ngenResponseHistory;
        const tipsApi = window.ngenHistoryTips;
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

    function ticketHistoryNeedsFetch(ticket) {
        return ticketHistoryNeedsDbDetailHydration(ticket) || ticketHistoryNeedsNgenNotificationFetch(ticket);
    }

    function upsertTicketHistoryDetailIntoOrgTickets(tn, hydrated) {
        if (!hydrated || !tn) return hydrated;
        const list = window.ORG_TICKETS || [];
        const idx = list.findIndex((t) => t && t.ticketNumber != null && String(t.ticketNumber).trim() === tn);
        if (idx >= 0) {
            list[idx] = { ...list[idx], ...hydrated, listSummary: false, hasFullDetail: true };
            return list[idx];
        }
        return hydrated;
    }

    async function ensureTicketHistoryDetailHydrated(tn, ticket) {
        if (!ticketHistoryNeedsDbDetailHydration(ticket)) return ticket;
        if (!window.authModule || !window.authModule.isAuthenticated()) return ticket;
        const orgId = getTicketHubApiOrganizationId(ticket);
        if (orgId == null) return ticket;
        const res = await window.authModule.apiRequest(
            `tickets/db-detail?organizationId=${encodeURIComponent(String(orgId))}&ticketNumber=${encodeURIComponent(tn)}&include=history`
        );
        const hydrated = res && res.ticket;
        if (!hydrated) return ticket;
        return upsertTicketHistoryDetailIntoOrgTickets(tn, hydrated) || ticket;
    }

    async function ensureTicketFullResponseHistoryLoaded(tn, ticket) {
        if (typeof window.ensureNgenProviderResponseHistoryLoaded === 'function') {
            return window.ensureNgenProviderResponseHistoryLoaded(ticket || { ticketNumber: tn });
        }
        return ticket;
    }

    function buildTicketHistoryUtilityPanel(ticket, opts) {
        const loading = opts && opts.loading === true;
        const siblings = getSiblingTicketsByBase(ticket);
        const utilityRowDetailCache = [];
        const utilitySectionsHtml = loading
            ? TICKET_HISTORY_TAB_LOADING_HTML
            : `<div class="ticket-history-tab-panel-inner">${buildUtilityHistorySectionsHtml(
                  groupUtilityEvents(collectUtilityResponseEvents(siblings)),
                  isTicketHubMobile(),
                  utilityRowDetailCache
              )}</div>`;
        return { utilitySectionsHtml, utilityRowDetailCache };
    }

    function wireTicketHistoryUtilityOpenButtons(wrap, utilityRowDetailCache) {
        if (!wrap || !utilityRowDetailCache) return;
        wrap.querySelectorAll('.ticket-history-open-rev-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const idx = parseInt(btn.getAttribute('data-detail-index'), 10);
                if (Number.isNaN(idx) || !utilityRowDetailCache[idx]) return;
                openUtilityHistoryDetailModal(utilityRowDetailCache[idx]);
            });
        });
    }

    function refreshTicketHistoryModalContent(wrap, ticket) {
        if (!wrap || !document.body.contains(wrap)) return;
        const { utilitySectionsHtml, utilityRowDetailCache } = buildTicketHistoryUtilityPanel(ticket);
        const utilityPanel = wrap.querySelector('[data-ticket-history-panel="utility"]');
        if (utilityPanel) utilityPanel.innerHTML = utilitySectionsHtml;
        wireTicketHistoryUtilityOpenButtons(wrap, utilityRowDetailCache);
    }

    async function loadTicketHistoryModalData(wrap, ticket) {
        const tn = ticket && ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
        if (!tn) {
            refreshTicketHistoryModalContent(wrap, ticket);
            return;
        }
        try {
            let updated = ticket;
            if (ticketHistoryNeedsDbDetailHydration(ticket)) {
                updated = (await ensureTicketHistoryDetailHydrated(tn, ticket)) || ticket;
            }
            if (!document.getElementById('ticketHistoryModal')) return;
            if (ticketHistoryNeedsNgenNotificationFetch(updated)) {
                updated = (await ensureTicketFullResponseHistoryLoaded(tn, updated)) || updated;
            }
            if (!document.getElementById('ticketHistoryModal')) return;
            refreshTicketHistoryModalContent(wrap, updated || ticket);
        } catch (e) {
            if (!document.getElementById('ticketHistoryModal')) return;
            console.warn('[ticket-hub] ticket history load:', e && e.message ? e.message : e);
            refreshTicketHistoryModalContent(wrap, ticket);
        }
    }

    function buildTicketViewLogPanelHtml(events) {
        if (!events || events.length === 0) {
            return '<div class="ticket-history-block"><p class="ticket-history-empty">No views recorded yet. Opening this ticket on the map or in Ticket hub adds each visit to this list.</p></div>';
        }
        const rows = events
            .map(
                ev =>
                    `<tr>
                    <td>${hubEscapeHtml(formatHubDate(ev.openedAt))}</td>
                    <td>${hubEscapeHtml(ev.userName != null && String(ev.userName).trim() !== '' ? ev.userName : 'User ' + String(ev.userId != null ? ev.userId : window.TICKET_HUB_TEXT.EM_DASH))}</td>
                </tr>`
            )
            .join('');
        return `
            <div class="ticket-history-block">
                <p class="ticket-history-modal-hint">Each time someone opened this ticket on the map or in Ticket hub (newest first). Only the last 500 views are kept.</p>
                <div class="ticket-history-table-wrap">
                    <table class="ticket-history-table">
                        <thead><tr><th>When</th><th>Who</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>`;
    }

    async function loadTicketViewLogTabContent(ticket, panelEl) {
        if (!panelEl || panelEl.dataset.viewLogLoaded === '1') return;
        panelEl.innerHTML =
            '<div class="ticket-history-tab-panel-inner"><div class="ticket-history-block"><p class="ticket-history-modal-hint">Loading...</p></div></div>';
        try {
            const orgId = getTicketHubApiOrganizationId(ticket);
            const tn = encodeURIComponent(String(ticket.ticketNumber).trim());
            const qp = orgId != null ? `?organizationId=${encodeURIComponent(String(orgId))}` : '';
            const data = await window.authModule.apiRequest(`tickets/${tn}/view-log${qp}`);
            const events = (data && data.events) || [];
            panelEl.innerHTML = `<div class="ticket-history-tab-panel-inner">${buildTicketViewLogPanelHtml(events)}</div>`;
            panelEl.dataset.viewLogLoaded = '1';
        } catch (e) {
            const msg = e && e.message ? String(e.message) : 'Could not load view log.';
            panelEl.innerHTML = `<div class="ticket-history-tab-panel-inner"><div class="ticket-history-block"><p class="ticket-history-empty">${hubEscapeHtml(msg)}</p></div></div>`;
            panelEl.dataset.viewLogLoaded = '1';
        }
    }

    function buildTicketHistoryTabsHtml(tabs, defaultTabId) {
        const tabButtons = tabs
            .map(t => {
                const active = t.id === defaultTabId;
                return `<button type="button" class="ticket-detail-tab${active ? ' ticket-detail-tab--active' : ''}" role="tab" data-ticket-history-tab="${t.id}" aria-selected="${active ? 'true' : 'false'}" tabindex="${active ? '0' : '-1'}"><span class="ticket-detail-tab-label">${t.label}</span></button>`;
            })
            .join('');
        const panels = tabs
            .map(t => {
                const active = t.id === defaultTabId;
                return `<div class="ticket-detail-tab-panel${active ? ' ticket-detail-tab-panel--active' : ''}" role="tabpanel" data-ticket-history-panel="${t.id}"${active ? '' : ' hidden'}>${t.html}</div>`;
            })
            .join('');
        return `<div class="ticket-detail-tabs-shell ticket-history-tabs-shell" data-ticket-history-default-tab="${defaultTabId}">
            <div class="ticket-detail-tablist" role="tablist" aria-label="Ticket history sections">${tabButtons}</div>
            <div class="ticket-detail-tab-panels">${panels}</div>
        </div>`;
    }

    function wireTicketHistoryTabs(wrap, ticket) {
        const shell = wrap.querySelector('.ticket-history-tabs-shell');
        if (!shell) return;
        const tablist = shell.querySelector('.ticket-detail-tablist');
        const tabs = Array.from(shell.querySelectorAll('[data-ticket-history-tab]'));
        const panels = Array.from(shell.querySelectorAll('[data-ticket-history-panel]'));

        function activateTab(tabId) {
            tabs.forEach(btn => {
                const isActive = btn.getAttribute('data-ticket-history-tab') === tabId;
                btn.classList.toggle('ticket-detail-tab--active', isActive);
                btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
                btn.tabIndex = isActive ? 0 : -1;
            });
            panels.forEach(panel => {
                const isActive = panel.getAttribute('data-ticket-history-panel') === tabId;
                panel.classList.toggle('ticket-detail-tab-panel--active', isActive);
                if (isActive) panel.removeAttribute('hidden');
                else panel.setAttribute('hidden', '');
            });
            if (tabId === 'viewed-by') {
                const panel = shell.querySelector('[data-ticket-history-panel="viewed-by"]');
                void loadTicketViewLogTabContent(ticket, panel);
            }
        }

        tablist.addEventListener('click', e => {
            const btn = e.target.closest('[data-ticket-history-tab]');
            if (!btn || !shell.contains(btn)) return;
            e.preventDefault();
            activateTab(btn.getAttribute('data-ticket-history-tab'));
        });

        tablist.addEventListener('keydown', e => {
            const current = document.activeElement;
            const idx = tabs.indexOf(current);
            if (idx < 0) return;
            let next = idx;
            if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
            else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
            else if (e.key === 'Home') next = 0;
            else if (e.key === 'End') next = tabs.length - 1;
            else return;
            e.preventDefault();
            tabs[next].focus();
            activateTab(tabs[next].getAttribute('data-ticket-history-tab'));
        });
    }

    function getHubOrganizationId() {
        if (window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function') {
            const id = window.orgSelectorModule.getCurrentOrgId();
            if (id != null) return id;
        }
        const u = window.authModule && window.authModule.getCurrentUser && window.authModule.getCurrentUser();
        return u && u.organizationId != null ? u.organizationId : null;
    }

    /** Org that owns the ticket row (partner shared tickets use source org id). */
    function getTicketHubApiOrganizationId(ticket) {
        if (ticket && ticket.organizationId != null) {
            return ticket.organizationId;
        }
        if (ticket && ticket.shared && ticket.sharedFromOrganizationId != null) {
            return ticket.sharedFromOrganizationId;
        }
        return getHubOrganizationId();
    }

    async function recordTicketHubView(ticket) {
        if (!window.authModule || !ticket || !ticket.ticketNumber) return;
        if (isHubTicketExternalForOrg(ticket)) return;
        const orgId = getTicketHubApiOrganizationId(ticket);
        if (orgId == null || orgId === '') return;
        const tn = encodeURIComponent(String(ticket.ticketNumber).trim());
        try {
            await window.authModule.apiRequest(
                `tickets/${tn}/view-log?organizationId=${encodeURIComponent(String(orgId))}`,
                { method: 'POST', body: JSON.stringify({}) }
            );
        } catch (e) {
            console.warn('Ticket hub: record view', e);
        }
    }

    function parseTimeMs(dateStr) {
        if (dateStr == null || dateStr === '') return 0;
        const d = new Date(dateStr);
        return isNaN(d.getTime()) ? 0 : d.getTime();
    }

    /** Non-empty string or em dash for timeline tables. */
    function timelineCellText(v) {
        if (v == null) return window.TICKET_HUB_TEXT.EM_DASH;
        const s = String(v).trim();
        return s !== '' ? s : window.TICKET_HUB_TEXT.EM_DASH;
    }

    /** Provider notification history entries for one utility authority. */
    function providerHistoryEntriesForAuthority(ticket, authorityId) {
        const aid = authorityId != null ? String(authorityId).trim() : '';
        if (!aid) return null;
        const legacyHistoryKey = 'ng' + 'enResponseHistory';
        const h = ticket && (ticket.providerResponseHistory || ticket[legacyHistoryKey]);
        const utils = h && h.normalized && Array.isArray(h.normalized.utilities) ? h.normalized.utilities : null;
        if (!utils || !utils.length) return null;
        const u = utils.find((x) => x && String(x.authorityId) === aid);
        if (!u || u.error || !Array.isArray(u.entries) || u.entries.length === 0) return null;
        return u.entries;
    }

    /**
     * Match this timeline row to one provider-history entry at the same response time
     * (exact, or within 2s with the same status code). Never pick an unrelated disputed row.
     */
    function matchingProviderHistoryEntry(ticket, authorityId, ev) {
        const entries = providerHistoryEntriesForAuthority(ticket, authorityId);
        if (!entries || !ev) return null;
        const evMs = parseTimeMs(ev.respondedAt);
        const evCode = ev.statusCode != null ? String(ev.statusCode).trim() : '';
        const evReq = ev.requestNumber != null ? String(ev.requestNumber).trim() : '';
        let best = null;
        let bestScore = -1;
        for (let i = 0; i < entries.length; i += 1) {
            const ent = entries[i];
            if (!ent) continue;
            const entCode = ent.code != null ? String(ent.code).trim() : '';
            const entMs = parseTimeMs(ent.at);
            const entReq = ent.requestNumber != null ? String(ent.requestNumber).trim() : '';
            if (evMs <= 0 || entMs <= 0) continue;
            const dt = Math.abs(entMs - evMs);
            let score = 0;
            if (dt === 0) {
                score = 2;
                if (evCode && entCode === evCode) score += 1;
                if (evReq && entReq && evReq === entReq) score += 1;
            } else if (dt <= 2000 && evCode && entCode === evCode) {
                score = 1;
                if (evReq && entReq && evReq === entReq) score += 1;
            } else {
                continue;
            }
            if (score > bestScore) {
                bestScore = score;
                best = ent;
            }
        }
        return best;
    }

    function disputeFlagsFromHistoryEntry(ent) {
        if (!ent) return null;
        const hitCode = ent.code != null ? String(ent.code).trim() : '';
        const locate =
            ent.disputeLocateCode != null && String(ent.disputeLocateCode).trim() !== ''
                ? String(ent.disputeLocateCode).trim()
                : null;
        return {
            isDisputed: ent.isDisputed === true || hitCode === '555',
            disputeLocateCode: locate,
        };
    }

    /** Attach isDisputed / disputeLocateCode for this row only (not every response for the operator). */
    function applyTimelineDisputeMeta(ev, ticket, authorityId) {
        if (!ev) return ev;
        const code = ev.statusCode != null ? String(ev.statusCode).trim() : '';
        let isDisputed = ev.isDisputed === true || code === '555';
        let disputeLocateCode =
            ev.disputeLocateCode != null && String(ev.disputeLocateCode).trim() !== ''
                ? String(ev.disputeLocateCode).trim()
                : null;
        if (!isDisputed || disputeLocateCode == null) {
            const fromHist = disputeFlagsFromHistoryEntry(matchingProviderHistoryEntry(ticket, authorityId, ev));
            if (fromHist) {
                if (!isDisputed && fromHist.isDisputed) isDisputed = true;
                if (disputeLocateCode == null && fromHist.disputeLocateCode) {
                    disputeLocateCode = fromHist.disputeLocateCode;
                }
            }
        }
        if (isDisputed) {
            ev.isDisputed = true;
            if (disputeLocateCode != null) ev.disputeLocateCode = disputeLocateCode;
        }
        return ev;
    }

    function timelineDisputeBadgeHtml(ev) {
        if (!ev || ev.isDisputed !== true) return '';
        const locate =
            ev.disputeLocateCode != null && String(ev.disputeLocateCode).trim() !== ''
                ? String(ev.disputeLocateCode).trim()
                : null;
        const locatePart = locate
            ? ` <span class="ticket-history-dispute-locate">(locate ${hubEscapeHtml(locate)})</span>`
            : '';
        return `<span class="ticket-history-dispute-badge" title="Utility response disputed">Disputed</span>${locatePart}`;
    }

    /**
     * `notes` from the most recent provider notification history step for this utility (matches `authorityId`).
     * @returns {string|null}
     */
    function latestProviderNotesFromHistory(ticket, authorityId) {
        const aid = authorityId != null ? String(authorityId).trim() : '';
        if (!aid) return null;
        const legacyHistoryKey = 'ng' + 'enResponseHistory';
        const h = ticket && (ticket.providerResponseHistory || ticket[legacyHistoryKey]);
        const utils = h && h.normalized && Array.isArray(h.normalized.utilities) ? h.normalized.utilities : null;
        if (!utils || !utils.length) return null;
        const u = utils.find(x => x && String(x.authorityId) === aid);
        if (!u || u.error || !Array.isArray(u.entries) || u.entries.length === 0) return null;
        let best = null;
        let bestMs = -1;
        for (let i = 0; i < u.entries.length; i++) {
            const ent = u.entries[i];
            if (!ent) continue;
            const ms = parseTimeMs(ent.at);
            if (ms >= bestMs) {
                bestMs = ms;
                best = ent;
            }
        }
        if (!best) return null;
        let notes = null;
        if (best.notesComment != null && String(best.notesComment).trim() !== '') {
            notes = String(best.notesComment).trim();
        }
        return notes != null && notes !== '' ? notes : null;
    }

    function firstNonemptyTimelineString() {
        for (let i = 0; i < arguments.length; i += 1) {
            const v = arguments[i];
            if (v == null) continue;
            const s = String(v).trim();
            if (s !== '') return s;
        }
        return null;
    }

    /** authorityId → { stationCode, operatorName } from all revision siblings. */
    function buildAuthorityLabelIndexFromSiblings(siblings) {
        const map = new Map();
        (siblings || []).forEach((ticket) => {
            const responses = Array.isArray(ticket && ticket.operatorResponses) ? ticket.operatorResponses : [];
            responses.forEach((r) => {
                if (!r || r.authorityId == null) return;
                const aid = String(r.authorityId).trim();
                if (!aid || map.has(aid)) return;
                const code = firstNonemptyTimelineString(r.stationCode, r.operatorCode);
                const name = firstNonemptyTimelineString(r.operatorName);
                map.set(aid, {
                    stationCode: code || window.TICKET_HUB_TEXT.EM_DASH,
                    operatorName: name || code || window.TICKET_HUB_TEXT.EM_DASH,
                });
            });
            const details = Array.isArray(ticket && ticket.stationDetails) ? ticket.stationDetails : [];
            details.forEach((d) => {
                if (!d) return;
                const aid =
                    d.authorityId != null
                        ? String(d.authorityId).trim()
                        : d.authority_id != null
                          ? String(d.authority_id).trim()
                          : '';
                if (!aid || map.has(aid)) return;
                const code = firstNonemptyTimelineString(d.code, d.stationCode, d.operatorCode);
                const name = firstNonemptyTimelineString(d.name, d.operatorName);
                if (!code && !name) return;
                map.set(aid, {
                    stationCode: code || window.TICKET_HUB_TEXT.EM_DASH,
                    operatorName: name || code || window.TICKET_HUB_TEXT.EM_DASH,
                });
            });
        });
        return map;
    }

    function labelsFromProviderUtilEntries(providerUtil) {
        if (!providerUtil || !Array.isArray(providerUtil.entries)) return null;
        for (let i = 0; i < providerUtil.entries.length; i += 1) {
            const entry = providerUtil.entries[i];
            if (!entry) continue;
            const name = firstNonemptyTimelineString(entry.updatedBy);
            if (!name) continue;
            return {
                utilityKey: name,
                stationCode: window.TICKET_HUB_TEXT.EM_DASH,
                operatorName: name,
            };
        }
        return null;
    }

    /**
     * Match provider authority id to the same utility grouping as operatorResponses (station / name).
     * @returns {{ utilityKey: string, stationCode: string, operatorName: string }}
     */
    function utilityLabelsForAuthorityId(ticket, authorityId, authorityIndex, providerUtil) {
        const aid = authorityId != null ? String(authorityId).trim() : '';
        if (aid && authorityIndex && authorityIndex.has(aid)) {
            const hit = authorityIndex.get(aid);
            const utilityKey =
                hit.stationCode !== window.TICKET_HUB_TEXT.EM_DASH
                    ? hit.stationCode
                    : hit.operatorName !== window.TICKET_HUB_TEXT.EM_DASH
                      ? hit.operatorName
                      : `authority-${aid}`;
            return { utilityKey, stationCode: hit.stationCode, operatorName: hit.operatorName };
        }
        const responses = Array.isArray(ticket.operatorResponses) ? ticket.operatorResponses : [];
        for (let i = 0; i < responses.length; i += 1) {
            const r = responses[i];
            if (!r || r.authorityId == null) continue;
            if (String(r.authorityId).trim() !== aid) continue;
            const code = firstNonemptyTimelineString(r.stationCode, r.operatorCode);
            const name = firstNonemptyTimelineString(r.operatorName);
            const utilityKey = code || name || `authority-${aid}`;
            return {
                utilityKey,
                stationCode: code || window.TICKET_HUB_TEXT.EM_DASH,
                operatorName: name || code || window.TICKET_HUB_TEXT.EM_DASH,
            };
        }
        const fromProvider = labelsFromProviderUtilEntries(providerUtil);
        if (fromProvider) return fromProvider;
        const details = Array.isArray(ticket.stationDetails) ? ticket.stationDetails : [];
        for (let i = 0; i < details.length; i += 1) {
            const d = details[i];
            if (!d) continue;
            const detailAid =
                d.authorityId != null
                    ? String(d.authorityId).trim()
                    : d.authority_id != null
                      ? String(d.authority_id).trim()
                      : '';
            if (detailAid && detailAid !== aid) continue;
            const code = firstNonemptyTimelineString(d.code, d.stationCode, d.operatorCode);
            const name = firstNonemptyTimelineString(d.name, d.operatorName);
            if (!code && !name) continue;
            const utilityKey = code || name || (aid ? `authority-${aid}` : `detail-${i}`);
            return {
                utilityKey,
                stationCode: code || window.TICKET_HUB_TEXT.EM_DASH,
                operatorName: name || code || window.TICKET_HUB_TEXT.EM_DASH,
            };
        }
        return {
            utilityKey: aid ? `authority-${aid}` : 'authority-unknown',
            stationCode: aid ? `Auth ${aid}` : window.TICKET_HUB_TEXT.EM_DASH,
            operatorName: aid ? `Utility (authority ${aid})` : 'Utility (unknown)',
        };
    }

    /** @param {string|null|undefined} requestNumber e.g. 2026030500318-001 */
    function revisionSuffixFromRequestNumber(requestNumber) {
        if (requestNumber == null || String(requestNumber).trim() === '') return null;
        const s = String(requestNumber).trim();
        const dash = s.lastIndexOf('-');
        if (dash === -1) return s;
        const suf = s.slice(dash + 1).trim();
        return suf !== '' ? suf : null;
    }

    /**
     * Flatten operator responses, stationDetails (when no operator rows), 811 map history, and provider API history across stored revisions.
     */
    function collectUtilityResponseEvents(siblings) {
        const events = [];
        const authorityIndex = buildAuthorityLabelIndexFromSiblings(siblings);
        siblings.forEach(ticket => {
            const revLabel = revisionLabelForTicket(ticket);
            const ticketUpdated = ticket.updatedAt || ticket.createdAt;
            const responses = Array.isArray(ticket.operatorResponses) ? ticket.operatorResponses : [];
            if (responses.length === 0) {
                const details = Array.isArray(ticket.stationDetails) ? ticket.stationDetails : [];
                details.forEach(d => {
                    const code = (d.code || d.stationCode || '').toString().trim();
                    const name = (d.name || d.operatorName || '').toString().trim();
                    const utilityKey = code || name || `unknown-${events.length}`;
                    const respondedAt = d.responseDate || d.respondedAt || null;
                    const codeDescription = timelineCellText(d.comment != null ? String(d.comment) : null);
                    events.push(
                        applyTimelineDisputeMeta(
                            {
                                utilityKey,
                                stationCode: code || window.TICKET_HUB_TEXT.EM_DASH,
                                operatorName: name || window.TICKET_HUB_TEXT.EM_DASH,
                                respondedAt,
                                statusCode: d.responseCode != null ? String(d.responseCode) : window.TICKET_HUB_TEXT.EM_DASH,
                                codeDescription,
                                notesComment: window.TICKET_HUB_TEXT.EM_DASH,
                                comment: codeDescription,
                                isDisputed: d.isDisputed === true,
                                disputeLocateCode:
                                    d.disputeLocateCode != null ? String(d.disputeLocateCode) : null,
                                requestNumber: d.requestNumber != null ? String(d.requestNumber) : null,
                                storedTicketNumber: String(ticket.ticketNumber || ''),
                                ticketId: ticket.id,
                                revisionLabel: revLabel,
                                ticketUpdatedAt: ticketUpdated,
                                sortTime: Math.max(parseTimeMs(respondedAt), parseTimeMs(ticketUpdated)),
                            },
                            ticket,
                            d.authorityId != null ? d.authorityId : d.authority_id
                        )
                    );
                });
            } else {
                responses.forEach((r, idx) => {
                    if (!r) return;
                    const code = (r.stationCode || r.operatorCode || '').toString().trim();
                    const name = (r.operatorName || '').toString().trim();
                    const utilityKey = code || name || `response-${ticket.id != null ? ticket.id : 't'}-${idx}`;
                    const respondedAt = r.respondedAt || null;
                    const statusCode =
                        r.statusCode != null && String(r.statusCode).trim() !== ''
                            ? String(r.statusCode).trim()
                            : r.operatorStatus != null && String(r.operatorStatus).trim() !== ''
                              ? String(r.operatorStatus).trim()
                              : window.TICKET_HUB_TEXT.EM_DASH;
                    const codeDescription = timelineCellText(r.comment != null ? String(r.comment) : null);
                    events.push(
                        applyTimelineDisputeMeta(
                            {
                                utilityKey,
                                stationCode: code || window.TICKET_HUB_TEXT.EM_DASH,
                                operatorName: name || window.TICKET_HUB_TEXT.EM_DASH,
                                respondedAt,
                                statusCode,
                                codeDescription,
                                notesComment: window.TICKET_HUB_TEXT.EM_DASH,
                                comment: codeDescription,
                                isDisputed: r.isDisputed === true,
                                disputeLocateCode:
                                    r.disputeLocateCode != null ? String(r.disputeLocateCode) : null,
                                requestNumber: r.requestNumber != null ? String(r.requestNumber) : null,
                                storedTicketNumber: String(ticket.ticketNumber || ''),
                                ticketId: ticket.id,
                                revisionLabel: revLabel,
                                ticketUpdatedAt: ticketUpdated,
                                sortTime: Math.max(parseTimeMs(respondedAt), parseTimeMs(ticketUpdated)),
                            },
                            ticket,
                            r.authorityId
                        )
                    );
                });
            }

            const mapHistory = Array.isArray(ticket.history) ? ticket.history : [];
            mapHistory.forEach(h => {
                const code = (h.operatorCode || h.stationCode || '').toString().trim();
                const name = (h.operatorName || '').toString().trim();
                const utilityKey = code || name || `map-${events.length}`;
                const respondedAt = h.respondedAt || h.responseReceived || null;
                const codeDescription = timelineCellText(h.comment != null ? String(h.comment) : null);
                events.push({
                    utilityKey,
                    stationCode: code || window.TICKET_HUB_TEXT.EM_DASH,
                    operatorName: name || window.TICKET_HUB_TEXT.EM_DASH,
                    respondedAt,
                    statusCode: h.statusCode != null ? String(h.statusCode) : window.TICKET_HUB_TEXT.EM_DASH,
                    codeDescription,
                    notesComment: window.TICKET_HUB_TEXT.EM_DASH,
                    comment: codeDescription,
                    storedTicketNumber: String(ticket.ticketNumber || ''),
                    ticketId: ticket.id,
                    revisionLabel: revLabel,
                    ticketUpdatedAt: ticketUpdated,
                    sortTime: Math.max(parseTimeMs(respondedAt), parseTimeMs(ticketUpdated))
                });
            });

            const legacyHistoryKey = 'ng' + 'enResponseHistory';
            const providerHist = ticket.providerResponseHistory || ticket[legacyHistoryKey];
            const providerUtils =
                !isNvPublicImportTicket(ticket) &&
                providerHist &&
                providerHist.normalized &&
                Array.isArray(providerHist.normalized.utilities) &&
                providerHist.normalized.utilities.length
                    ? providerHist.normalized.utilities
                    : null;
            if (providerUtils) {
                providerUtils.forEach(u => {
                    if (!u || u.error) return;
                    const aid = u.authorityId != null ? String(u.authorityId).trim() : '';
                    const labels = utilityLabelsForAuthorityId(ticket, aid, authorityIndex, u);
                    if (
                        labels.operatorName.indexOf('Utility (authority ') === 0 &&
                        (Array.isArray(ticket.operatorResponses) ? ticket.operatorResponses.length : 0) > 0
                    ) {
                        return;
                    }
                    const { utilityKey, stationCode, operatorName } = labels;
                    const entries = Array.isArray(u.entries) ? u.entries : [];
                    entries.forEach(entry => {
                        if (!entry) return;
                        const respondedAt = entry.at != null ? String(entry.at) : null;
                        const rn = entry.requestNumber != null ? String(entry.requestNumber) : null;
                        const revFromProvider = revisionSuffixFromRequestNumber(rn);
                        const codeDescription = timelineCellText(
                            entry.codeDescription != null && String(entry.codeDescription).trim() !== ''
                                ? String(entry.codeDescription)
                                : entry.comment != null && String(entry.comment).trim() !== ''
                                  ? String(entry.comment)
                                  : null
                        );
                        const notesComment = timelineCellText(
                            entry.notesComment != null && String(entry.notesComment).trim() !== ''
                                ? String(entry.notesComment)
                                : null
                        );
                        events.push(
                            applyTimelineDisputeMeta(
                                {
                                    utilityKey,
                                    stationCode,
                                    operatorName,
                                    respondedAt,
                                    statusCode: entry.code != null ? String(entry.code) : window.TICKET_HUB_TEXT.EM_DASH,
                                    codeDescription,
                                    notesComment,
                                    comment: codeDescription,
                                    updatedBy: entry.updatedBy != null ? String(entry.updatedBy) : null,
                                    isDisputed: entry.isDisputed === true,
                                    disputeLocateCode:
                                        entry.disputeLocateCode != null ? String(entry.disputeLocateCode) : null,
                                    enquiryId: entry.enquiryId != null ? String(entry.enquiryId) : null,
                                    requestNumber: rn,
                                    storedTicketNumber: String(ticket.ticketNumber || ''),
                                    ticketId: ticket.id,
                                    revisionLabel: revFromProvider != null ? revFromProvider : revLabel,
                                    ticketUpdatedAt: ticketUpdated,
                                    sortTime: Math.max(parseTimeMs(respondedAt), parseTimeMs(ticketUpdated)),
                                },
                                ticket,
                                aid
                            )
                        );
                    });
                });
            }
        });
        return events;
    }

    function groupUtilityEvents(events) {
        const map = new Map();
        events.forEach(ev => {
            const k = ev.utilityKey;
            if (!map.has(k)) map.set(k, []);
            map.get(k).push(ev);
        });
        map.forEach(list => {
            list.sort((a, b) => b.sortTime - a.sortTime);
        });
        return Array.from(map.entries()).sort((a, b) => {
            const na = (a[1][0] && a[1][0].operatorName) || '';
            const nb = (b[1][0] && b[1][0].operatorName) || '';
            return String(na).localeCompare(String(nb));
        });
    }

    function buildUtilityHistorySectionsHtml(grouped, isMobile, rowDetailCache) {
        if (!grouped.length) {
            return `<div class="ticket-history-empty">No utility timeline rows yet. This window loads notification history on open. If operator responses show in the hub but this list stays empty, check nGen credentials or try again.</div>`;
        }
        return grouped
            .map(([utilityKey, list]) => {
                const head = list[0];
                const title = `${hubEscapeHtml(head.operatorName)} <span class="ticket-history-utility-code">(${hubEscapeHtml(head.stationCode)})</span>`;
                const subRows = list
                    .map(ev => {
                        const revRaw =
                            ev.revisionLabel != null && String(ev.revisionLabel).trim() !== ''
                                ? String(ev.revisionLabel).trim()
                                : null;
                        const rev = revRaw != null ? hubEscapeHtml(revRaw) : window.TICKET_HUB_TEXT.EM_DASH;
                        const when = ev.respondedAt ? formatHubDate(ev.respondedAt) : window.TICKET_HUB_TEXT.EM_DASH;
                        const snap = formatHubDate(ev.ticketUpdatedAt);
                        const cur =
                            idsMatch(ev.ticketId, selectedHubTicketId) ? ' ticket-history-subrow-current' : '';
                        const disputedCls = ev.isDisputed === true ? ' ticket-history-subrow-disputed' : '';
                        const disputeBadge = timelineDisputeBadgeHtml(ev);
                        if (isMobile) {
                            const detailIdx = rowDetailCache.length;
                            rowDetailCache.push(ev);
                            return `<tr class="ticket-history-subrow ticket-history-subrow-mobile${cur}${disputedCls}">
                            <td>${when}</td>
                            <td>${hubEscapeHtml(ev.statusCode)}${disputeBadge}</td>
                            <td class="ticket-history-col-rev-mobile">${rev}</td>
                            <td class="ticket-history-sub-open-cell"><button type="button" class="ticket-hub-mini-btn ticket-history-open-rev-btn" data-detail-index="${detailIdx}">Open</button></td>
                        </tr>`;
                        }
                        const codeDesc = hubEscapeHtml(ev.codeDescription != null ? ev.codeDescription : ev.comment != null ? ev.comment : window.TICKET_HUB_TEXT.EM_DASH);
                        const notesCol = hubEscapeHtml(ev.notesComment != null ? ev.notesComment : window.TICKET_HUB_TEXT.EM_DASH);
                        return `<tr class="ticket-history-subrow${cur}${disputedCls}">
                            <td>${when}</td>
                            <td>${hubEscapeHtml(ev.statusCode)}${disputeBadge}</td>
                            <td class="ticket-history-col-code-desc">${codeDesc}</td>
                            <td class="ticket-history-col-notes">${notesCol}</td>
                            <td><code>${hubEscapeHtml(ev.storedTicketNumber)}</code></td>
                            <td>${rev}</td>
                            <td>${snap}</td>
                        </tr>`;
                    })
                    .join('');
                const thead = isMobile
                    ? `<thead>
                            <tr>
                                <th>Response date</th>
                                <th>Code</th>
                                <th>Rev</th>
                                <th>Open</th>
                            </tr>
                        </thead>`
                    : `<thead>
                            <tr>
                                <th>Response date</th>
                                <th>Code</th>
                                <th>Code Description</th>
                                <th>Comments</th>
                                <th>Stored #</th>
                                <th>Rev</th>
                                <th>Row updated</th>
                            </tr>
                        </thead>`;
                const tableClass = isMobile
                    ? 'ticket-history-subtable ticket-history-subtable--mobile'
                    : 'ticket-history-subtable';
                return `
            <section class="ticket-history-utility-section" data-utility-key="${hubEscapeHtml(utilityKey)}">
                <h4 class="ticket-history-utility-heading">${title}</h4>
                <p class="ticket-history-utility-sub"></p>
                <div class="ticket-history-subtable-wrap ${isMobile ? 'ticket-history-subtable-wrap--mobile' : ''}">
                    <table class="${tableClass}">
                        ${thead}
                        <tbody>${subRows}</tbody>
                    </table>
                </div>
            </section>`;
            })
            .join('');
    }

    function closeUtilityHistoryDetailModal() {
        const el = document.getElementById('ticketHistoryUtilityDetailModal');
        if (el) el.remove();
    }

    function openUtilityHistoryDetailModal(ev) {
        closeUtilityHistoryDetailModal();
        const when = ev.respondedAt ? formatHubDate(ev.respondedAt) : window.TICKET_HUB_TEXT.EM_DASH;
        const rev =
            ev.revisionLabel != null && String(ev.revisionLabel).trim() !== ''
                ? hubEscapeHtml(String(ev.revisionLabel).trim())
                : window.TICKET_HUB_TEXT.EM_DASH;
        const snap = formatHubDate(ev.ticketUpdatedAt);
        const wrap = document.createElement('div');
        wrap.id = 'ticketHistoryUtilityDetailModal';
        wrap.className = 'ticket-history-detail-overlay';
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'true');
        wrap.setAttribute('aria-label', 'Response details');
        const detailCodeDesc =
            ev.codeDescription != null ? String(ev.codeDescription) : ev.comment != null ? String(ev.comment) : window.TICKET_HUB_TEXT.EM_DASH;
        const detailNotes = ev.notesComment != null ? String(ev.notesComment) : window.TICKET_HUB_TEXT.EM_DASH;
        const disputeRows =
            ev.isDisputed === true
                ? `<dt>Disputed</dt><dd>Yes${
                      ev.disputeLocateCode != null && String(ev.disputeLocateCode).trim() !== ''
                          ? ` (locate ${hubEscapeHtml(String(ev.disputeLocateCode).trim())})`
                          : ''
                  }</dd>`
                : '';
        wrap.innerHTML = `
            <div class="ticket-history-detail-panel">
                <div class="ticket-history-detail-header">
                    <h4 class="ticket-history-detail-title">Response details</h4>
                    <button type="button" class="ticket-history-detail-close" aria-label="Close">&times;</button>
                </div>
                <div class="ticket-history-detail-body">
                    <dl class="ticket-history-detail-dl">
                        <dt>Response date</dt><dd>${hubEscapeHtml(when)}</dd>
                        <dt>Code</dt><dd>${hubEscapeHtml(ev.statusCode)}</dd>
                        ${disputeRows}
                        <dt>Code Description</dt><dd>${hubEscapeHtml(detailCodeDesc)}</dd>
                        <dt>Comments</dt><dd>${hubEscapeHtml(detailNotes)}</dd>
                        <dt>Stored #</dt><dd><code>${hubEscapeHtml(ev.storedTicketNumber)}</code></dd>
                        <dt>Rev</dt><dd>${rev}</dd>
                        <dt>Row updated</dt><dd>${hubEscapeHtml(snap)}</dd>
                    </dl>
                </div>
            </div>`;
        wrap.addEventListener('click', closeUtilityHistoryDetailModal);
        wrap.querySelector('.ticket-history-detail-panel').addEventListener('click', e => e.stopPropagation());
        wrap.querySelector('.ticket-history-detail-close').addEventListener('click', closeUtilityHistoryDetailModal);
        document.body.appendChild(wrap);
    }

    function ticketHistoryShowsFullHistoryPdf(ticket) {
        if (!ticket || isNvPublicImportTicket(ticket)) return false;
        const flow = window.ticketDocumentPackFlow;
        return (
            flow &&
            typeof flow.shouldShowDocumentPackButton === 'function' &&
            flow.shouldShowDocumentPackButton(ticket)
        );
    }

    function wireTicketHistoryFullHistoryPdfButton(wrap, ticket) {
        const btn = wrap && wrap.querySelector('.ticket-history-full-history-pdf-btn');
        if (!btn) return;
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const flow = window.ticketDocumentPackFlow;
            if (!flow || typeof flow.downloadFullHistoryPdf !== 'function') return;
            const prevText = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Downloading…';
            try {
                await flow.downloadFullHistoryPdf(ticket);
            } catch (err) {
                const msg =
                    err && err.message
                        ? String(err.message)
                        : 'Failed to download full history PDF.';
                if (typeof window.appAlert === 'function') {
                    void window.appAlert(msg);
                } else {
                    console.warn('[ticket-hub] full history PDF:', msg);
                }
            } finally {
                btn.disabled = false;
                btn.textContent = prevText || 'Download full history PDF';
            }
        });
    }

    function openTicketHistoryModal(ticket) {
        closeTicketHistoryModal();
        const base = normalizeHubTicketBase(ticket.ticketNumber);
        const needsFetch = ticketHistoryNeedsFetch(ticket);
        const { utilitySectionsHtml, utilityRowDetailCache } = buildTicketHistoryUtilityPanel(ticket, {
            loading: needsFetch,
        });
        const showFullHistoryPdf = ticketHistoryShowsFullHistoryPdf(ticket);
        const defaultTab = 'utility';
        const historyTabs = [
            {
                id: 'utility',
                label: 'Response History',
                html: utilitySectionsHtml,
            },
        ];
        if (!isHubTicketExternalForOrg(ticket)) {
            historyTabs.push({
                id: 'viewed-by',
                label: 'Viewed by',
                html: '<div class="ticket-history-tab-panel-inner"><div class="ticket-history-block"><p class="ticket-history-modal-hint">Loading...</p></div></div>',
            });
        }
        const tabsHtml = buildTicketHistoryTabsHtml(historyTabs, defaultTab);
        const pdfBtnHtml = showFullHistoryPdf
            ? '<button type="button" class="ticket-history-full-history-pdf-btn">Download full history PDF</button>'
            : '';

        const wrap = document.createElement('div');
        wrap.id = 'ticketHistoryModal';
        wrap.className = 'ticket-history-modal-overlay';
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'true');
        wrap.setAttribute('aria-label', 'Ticket history');
        wrap.innerHTML = `
            <div class="ticket-history-modal-panel ticket-history-modal-panel-wide">
                <div class="ticket-history-modal-header">
                    <h3 class="ticket-history-modal-title">Ticket history - ${hubEscapeHtml(base)}</h3>
                    <div class="ticket-history-modal-header-actions">
                        ${pdfBtnHtml}
                        <button type="button" class="ticket-history-modal-close" aria-label="Close">&times;</button>
                    </div>
                </div>
                <div class="ticket-history-modal-body">
                    ${tabsHtml}
                </div>
            </div>`;
        wrap.addEventListener('click', function () {
            closeTicketHistoryModal();
        });
        wrap.querySelector('.ticket-history-modal-panel').addEventListener('click', e => e.stopPropagation());
        wrap.querySelector('.ticket-history-modal-close').addEventListener('click', closeTicketHistoryModal);
        wireTicketHistoryTabs(wrap, ticket);
        wireTicketHistoryUtilityOpenButtons(wrap, utilityRowDetailCache);
        wireTicketHistoryFullHistoryPdfButton(wrap, ticket);
        document.body.appendChild(wrap);
        if (needsFetch) {
            void loadTicketHistoryModalData(wrap, ticket);
        }
    }

    // Exposed so the map ticket popup can reuse this window (see tickets-popup-assignees.js).
    window.openTicketHistoryModal = openTicketHistoryModal;
    // Map selection and Ticket hub detail both POST to the same view-log endpoint.
    window.recordTicketView = recordTicketHubView;

