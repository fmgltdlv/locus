'use strict';

/** @typedef {'details'|'responses'|'notes'} TicketDetailTabId */

const TICKET_DETAIL_TAB_ORDER = ['details', 'responses', 'notes'];

const TICKET_DETAIL_TAB_LABELS = {
    details: 'Details',
    responses: 'Responses',
    notes: 'Notes',
};

function ticketDetailTabDotAriaLabel(tabId, status) {
    if (!status) return '';
    const labels = {
        'not-ready': 'Not ready',
        'action-required': 'Review required',
        ready: 'Ready',
    };
    const tabLabel = TICKET_DETAIL_TAB_LABELS[tabId] || tabId;
    return `${tabLabel}: ${labels[status] || status}`;
}

function getTicketResponsesTabStatus(ticket) {
    if (!ticket) return null;
    const operatorResponses = ticket.operatorResponses || [];
    let worst = null;
    const outstanding = ticket.outstandingOperators || [];
    if (outstanding.length > 0 && operatorResponses.length === 0) {
        return 'NOT_READY';
    }
    for (const response of operatorResponses) {
        const operatorStatus = response.effectiveStatus || response.operatorStatus || 'READY';
        if (operatorStatus === 'NOT_READY') {
            return 'NOT_READY';
        }
        if (operatorStatus === 'ACTION_REQUIRED') {
            worst = 'ACTION_REQUIRED';
        }
        const code = response.stationCode || response.operatorCode || response.operatorName;
        if (
            code &&
            outstanding.some(
                (o) => o === response.operatorName || o === response.stationCode || o === code
            )
        ) {
            if (!worst) worst = 'ACTION_REQUIRED';
        }
    }
    if (worst) return worst;
    if (outstanding.length > 0) return 'ACTION_REQUIRED';
    return null;
}

function workflowStatusToDotClass(status) {
    if (!status) return null;
    switch (status) {
        case 'NOT_READY':
            return 'not-ready';
        case 'ACTION_REQUIRED':
            return 'action-required';
        default:
            return null;
    }
}

function getTicketDetailTabCounts(ticket) {
    if (!ticket) return {};
    let responses = 0;
    const progressFn =
        (window.ticketsModule && window.ticketsModule.getTicketResponseProgress) ||
        window.getTicketResponseProgress;
    if (typeof progressFn === 'function') {
        const progress = progressFn(ticket);
        if (progress && progress.required != null) responses = Number(progress.required) || 0;
        else if (progress && progress.received != null) responses = Number(progress.received) || 0;
    }
    if (!responses && Array.isArray(ticket.operatorResponses)) {
        responses = ticket.operatorResponses.length;
    }
    return {
        details: null,
        responses: responses > 0 ? responses : null,
        notes: null,
    };
}

function getTicketDetailTabStatuses(ticket, _opts) {
    const responsesRaw = getTicketResponsesTabStatus(ticket);
    const notesRaw = ticket && ticket.notesReviewRequired ? 'ACTION_REQUIRED' : null;
    return {
        details: null,
        responses: workflowStatusToDotClass(responsesRaw),
        notes: workflowStatusToDotClass(notesRaw),
    };
}

function buildTicketDetailTabDotHtml(tabId, status) {
    if (!status) return '';
    const aria = ticketDetailTabDotAriaLabel(tabId, status);
    return `<span class="ticket-detail-tab-dot ticket-detail-tab-dot--${status}" aria-label="${aria.replace(/"/g, '&quot;')}"></span>`;
}

function resolveTicketDetailDefaultTab(_ticket, _tabStatuses) {
    let pref = 'responses';
    if (typeof window.getTicketDetailDefaultTabPreference === 'function') {
        pref = window.getTicketDetailDefaultTabPreference();
    }
    if (TICKET_DETAIL_TAB_ORDER.includes(pref)) return pref;
    return 'responses';
}

function buildTicketResponsesLoadingHtml() {
    const ell = window.TICKET_HUB_TEXT && window.TICKET_HUB_TEXT.ELLIPSIS ? window.TICKET_HUB_TEXT.ELLIPSIS : '…';
    const loader =
        typeof window.getAppLoaderHtml === 'function'
            ? window.getAppLoaderHtml()
            : '<div class="app-loading-indicator" role="status" aria-label="Loading"></div>';
    return `<div class="ticket-responses-loading" aria-busy="true" aria-live="polite">
        <div class="ticket-hub-detail-refresh-inner">
            ${loader}
            <p class="ticket-hub-loading-text">Loading operator responses${ell}</p>
        </div>
    </div>`;
}

function buildTicketResponsesEmptyHtml() {
    const msg =
        typeof window.t === 'function'
            ? window.t('No operator responses available')
            : 'No operator responses available';
    return `<div class="ticket-responses-empty"><p class="ticket-hub-loading-text">${msg}</p></div>`;
}

function buildTicketDetailTabsHtml(opts) {
    const detailsHtml = (opts && opts.detailsHtml) || '';
    const responsesHtml = (opts && opts.responsesHtml) || '';
    const notesHtml = (opts && opts.notesHtml) || '';
    const tabStatuses = (opts && opts.tabStatuses) || {};
    const tabCounts = (opts && opts.tabCounts) || {};
    const defaultTab = (opts && opts.defaultTab) || 'responses';
    const tabs = [
        { id: 'details', label: TICKET_DETAIL_TAB_LABELS.details, html: detailsHtml },
        { id: 'responses', label: TICKET_DETAIL_TAB_LABELS.responses, html: responsesHtml },
        { id: 'notes', label: TICKET_DETAIL_TAB_LABELS.notes, html: notesHtml },
    ];
    const tabButtons = tabs
        .map((t) => {
            const active = t.id === defaultTab;
            const dot = buildTicketDetailTabDotHtml(t.id, tabStatuses[t.id]);
            const count = tabCounts[t.id];
            const countHtml =
                count != null && count !== ''
                    ? `<span class="ticket-detail-tab-count">${String(count)}</span>`
                    : '';
            return `<button type="button" class="ticket-detail-tab${active ? ' ticket-detail-tab--active' : ''}" role="tab" id="ticket-detail-tab-${t.id}" data-ticket-detail-tab="${t.id}" aria-selected="${active ? 'true' : 'false'}" aria-controls="ticket-detail-panel-${t.id}" tabindex="${active ? '0' : '-1'}"><span class="ticket-detail-tab-label">${t.label}</span>${countHtml}${dot}</button>`;
        })
        .join('');
    const panels = tabs
        .map((t) => {
            const active = t.id === defaultTab;
            return `<div class="ticket-detail-tab-panel${active ? ' ticket-detail-tab-panel--active' : ''}" role="tabpanel" id="ticket-detail-panel-${t.id}" data-ticket-detail-panel="${t.id}" aria-labelledby="ticket-detail-tab-${t.id}"${active ? '' : ' hidden'}>${t.html}</div>`;
        })
        .join('');
    return `<div class="ticket-detail-tabs-shell" data-ticket-detail-default-tab="${defaultTab}">
        <div class="ticket-detail-tablist app-overlay-scroll-x" role="tablist" aria-label="Ticket detail sections">${tabButtons}</div>
        <div class="ticket-detail-tab-panels">${panels}</div>
    </div>`;
}

function updateTicketDetailTabDot(container, tabId, status) {
    if (!container) return;
    const btn = container.querySelector(`[data-ticket-detail-tab="${tabId}"]`);
    if (!btn) return;
    const existing = btn.querySelector('.ticket-detail-tab-dot');
    if (existing) existing.remove();
    const dotHtml = buildTicketDetailTabDotHtml(tabId, status);
    if (dotHtml) {
        btn.insertAdjacentHTML('beforeend', dotHtml);
    }
}

function wireTicketDetailTabs(container, options) {
    if (!container) return;
    const shell = container.querySelector('.ticket-detail-tabs-shell');
    if (!shell || shell.dataset.ticketDetailTabsInit === '1') return;
    shell.dataset.ticketDetailTabsInit = '1';
    const onTabChange =
        options && typeof options.onTabChange === 'function' ? options.onTabChange : null;
    const tablist = shell.querySelector('.ticket-detail-tablist');
    const tabs = Array.from(shell.querySelectorAll('[data-ticket-detail-tab]'));
    const panels = Array.from(shell.querySelectorAll('[data-ticket-detail-panel]'));

    function activateTab(tabId) {
        tabs.forEach((btn) => {
            const isActive = btn.getAttribute('data-ticket-detail-tab') === tabId;
            btn.classList.toggle('ticket-detail-tab--active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
            btn.tabIndex = isActive ? 0 : -1;
        });
        panels.forEach((panel) => {
            const isActive = panel.getAttribute('data-ticket-detail-panel') === tabId;
            panel.classList.toggle('ticket-detail-tab-panel--active', isActive);
            if (isActive) panel.removeAttribute('hidden');
            else panel.setAttribute('hidden', '');
        });
        if (onTabChange) onTabChange(tabId, shell);
    }

    tablist.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-ticket-detail-tab]');
        if (!btn || !shell.contains(btn)) return;
        e.preventDefault();
        activateTab(btn.getAttribute('data-ticket-detail-tab'));
    });

    tablist.addEventListener('keydown', (e) => {
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
        activateTab(tabs[next].getAttribute('data-ticket-detail-tab'));
    });

    const initial = shell.getAttribute('data-ticket-detail-default-tab') || 'responses';
    if (onTabChange && initial) onTabChange(initial, shell);

    if (tablist && window.overlayScrollModule && typeof window.overlayScrollModule.ensureOverlayScroll === 'function') {
        window.overlayScrollModule.ensureOverlayScroll(tablist);
    }
}

window.getTicketDetailTabCounts = getTicketDetailTabCounts;
window.getTicketDetailTabStatuses = getTicketDetailTabStatuses;
window.buildTicketDetailTabDotHtml = buildTicketDetailTabDotHtml;
window.resolveTicketDetailDefaultTab = resolveTicketDetailDefaultTab;
window.buildTicketDetailTabsHtml = buildTicketDetailTabsHtml;
window.buildTicketResponsesLoadingHtml = buildTicketResponsesLoadingHtml;
window.buildTicketResponsesEmptyHtml = buildTicketResponsesEmptyHtml;
window.updateTicketDetailTabDot = updateTicketDetailTabDot;
window.wireTicketDetailTabs = wireTicketDetailTabs;
