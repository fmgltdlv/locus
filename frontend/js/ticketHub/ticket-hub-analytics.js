'use strict';

const ANALYTICS_STATUS_META = [
    { key: 'READY', label: 'Ready', color: '#22c55e' },
    { key: 'NOT_READY', label: 'Not ready', color: '#f97316' },
    { key: 'ACTION_REQUIRED', label: 'Review req.', color: '#facc15' },
    { key: 'EXPIRING_SOON', label: 'Expiring soon', color: '#ef4444' },
    { key: 'EXPIRED', label: 'Expired', color: '#6b7280' },
    { key: 'CANCELLED', label: 'Cancelled', color: '#9ca3af' },
];

const ANALYTICS_DEFAULT_RANGE_DAYS = 90;

/** @type {{ key: string, data: object, topProjects: Array<[string, number]> } | null} */
let analyticsSessionCache = null;

function analyticsEscapeHtml(s) {
    if (s == null || s === '') return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function canViewTicketHubAnalytics() {
    if (!window.authModule) return false;
    if (window.authModule.isTechInCurrentOrg && window.authModule.isTechInCurrentOrg()) return false;
    if (window.authModule.isDev && window.authModule.isDev()) return true;
    return !!(window.authModule.isAdmin && window.authModule.isAdmin());
}

function getAnalyticsOrgLabel() {
    const selector = document.getElementById('orgSelector');
    if (selector && selector.selectedOptions && selector.selectedOptions[0]) {
        const text = String(selector.selectedOptions[0].textContent || '').trim();
        if (text && !/^select organization/i.test(text) && text !== 'No Organization') {
            return text.replace(/\s*\(Default\)\s*$/i, '').replace(/\s*\(View Only\)\s*$/i, '').trim();
        }
    }
    return 'Current organization';
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function formatYmd(date) {
    if (typeof window.getPacificYmd === 'function') {
        return window.getPacificYmd(date || new Date());
    }
    const d = date || new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function defaultAnalyticsDateRange() {
    const to = formatYmd(new Date());
    const from =
        typeof window.addPacificYmdDays === 'function'
            ? window.addPacificYmdDays(to, -(ANALYTICS_DEFAULT_RANGE_DAYS - 1))
            : formatYmd(new Date(Date.now() - (ANALYTICS_DEFAULT_RANGE_DAYS - 1) * 86400000));
    return { from, to, dateField: 'lodged_on' };
}

function readAnalyticsFiltersFromDom() {
    const fromEl = document.getElementById('ticketHubAnalyticsFrom');
    const toEl = document.getElementById('ticketHubAnalyticsTo');
    const fieldEl = document.getElementById('ticketHubAnalyticsDateField');
    const defaults = defaultAnalyticsDateRange();
    const from = fromEl && fromEl.value ? String(fromEl.value).trim() : defaults.from;
    const to = toEl && toEl.value ? String(toEl.value).trim() : defaults.to;
    const dateField =
        fieldEl && fieldEl.value === 'expires_at' ? 'expires_at' : defaults.dateField;
    return { from, to, dateField };
}

function analyticsApiBase() {
    const base =
        window.authModule && window.authModule.API_BASE ? String(window.authModule.API_BASE) : '/api';
    let orgId = null;
    if (window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function') {
        orgId = window.orgSelectorModule.getCurrentOrgId();
    } else if (window.authModule && window.authModule.getCurrentUser) {
        const u = window.authModule.getCurrentUser();
        orgId = u && u.organizationId;
    }
    return { base, orgId };
}

function analyticsCacheKey(orgId, filters) {
    return `${orgId}|${filters.from}|${filters.to}|${filters.dateField}`;
}

function invalidateAnalyticsCache() {
    analyticsSessionCache = null;
}

function analyticsQueryString(filters) {
    const api = analyticsApiBase();
    if (!api.orgId) return '';
    const params = new URLSearchParams({
        organizationId: String(api.orgId),
        from: filters.from,
        to: filters.to,
        dateField: filters.dateField,
    });
    return `?${params.toString()}`;
}

async function fetchAnalyticsSummary(filters, forceRefresh) {
    const api = analyticsApiBase();
    if (!api.orgId || !window.authModule || !window.authModule.apiRequest) {
        return { error: 'Organization required' };
    }
    const key = analyticsCacheKey(api.orgId, filters);
    if (!forceRefresh && analyticsSessionCache && analyticsSessionCache.key === key) {
        return { data: analyticsSessionCache.data, topProjects: analyticsSessionCache.topProjects };
    }
    try {
        const qs = analyticsQueryString(filters);
        const data = await window.authModule.apiRequest(`${api.base}/tickets/analytics/summary${qs}`);
        let topProjects = null;
        try {
            const topData = await window.authModule.apiRequest(
                `${api.base}/tickets/job-projects/analytics/top-projects?organizationId=${encodeURIComponent(String(api.orgId))}`
            );
            const projects = Array.isArray(topData && topData.projects) ? topData.projects : [];
            topProjects = projects.map((p) => [p.jobName || p.jobNameKey || '', p.ticketCount || 0]);
        } catch (e) {
            console.warn('[analytics] top projects:', e);
        }
        analyticsSessionCache = { key, data, topProjects: topProjects || [] };
        return { data, topProjects: topProjects || [] };
    } catch (e) {
        return { error: (e && e.message) || 'Failed to load analytics' };
    }
}

function lookupCodeDescription(code) {
    if (typeof window.lookupOperatorResponseCodeCatalogDescription === 'function') {
        return window.lookupOperatorResponseCodeCatalogDescription(code) || '';
    }
    return '';
}

function analyticsSummaryCard(label, value, hint) {
    const title = hint ? ` title="${analyticsEscapeHtml(hint)}"` : '';
    return (
        `<div class="ticket-hub-analytics-summary-card"${title}>` +
        `<span class="ticket-hub-analytics-summary-label">${analyticsEscapeHtml(label)}</span>` +
        `<span class="ticket-hub-analytics-summary-value">${analyticsEscapeHtml(String(value))}</span>` +
        '</div>'
    );
}

function renderAnalyticsStatusBreakdown(statusCounts) {
    const rows = ANALYTICS_STATUS_META.map((meta) => ({
        label: meta.label,
        color: meta.color,
        count: (statusCounts && statusCounts[meta.key]) || 0,
    }));
    const other = statusCounts && statusCounts.OTHER ? statusCounts.OTHER : 0;
    if (other > 0) {
        rows.push({ label: 'Other', color: '#64748b', count: other });
    }
    const max = Math.max(1, ...rows.map((r) => r.count));
    const bars = rows
        .map((row) => {
            const pct = Math.round((row.count / max) * 100);
            return (
                `<div class="ticket-hub-analytics-bar-row">` +
                `<span class="ticket-hub-analytics-bar-label">${analyticsEscapeHtml(row.label)}</span>` +
                `<div class="ticket-hub-analytics-bar-track" aria-hidden="true">` +
                `<div class="ticket-hub-analytics-bar-fill" style="width:${pct}%;background:${row.color};"></div>` +
                '</div>' +
                `<span class="ticket-hub-analytics-bar-value">${row.count}</span>` +
                '</div>'
            );
        })
        .join('');
    return `<div class="ticket-hub-analytics-bars">${bars}</div>`;
}

function renderCodeBreakdown(title, byCodeObj, emptyLabel) {
    const entries = Object.entries(byCodeObj || {})
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
    if (!entries.length) {
        return `<div class="ticket-hub-analytics-muted">${analyticsEscapeHtml(emptyLabel)}</div>`;
    }
    const max = Math.max(1, ...entries.map((e) => e.count));
    const bars = entries
        .map((row) => {
            const pct = Math.round((row.count / max) * 100);
            const desc = lookupCodeDescription(row.code);
            const label = desc ? `${row.code} — ${desc}` : row.code;
            return (
                `<div class="ticket-hub-analytics-bar-row" title="${analyticsEscapeHtml(label)}">` +
                `<span class="ticket-hub-analytics-bar-label">${analyticsEscapeHtml(row.code)}</span>` +
                `<div class="ticket-hub-analytics-bar-track" aria-hidden="true">` +
                `<div class="ticket-hub-analytics-bar-fill ticket-hub-analytics-bar-fill--code" style="width:${pct}%;"></div>` +
                '</div>' +
                `<span class="ticket-hub-analytics-bar-value">${row.count}</span>` +
                '</div>'
            );
        })
        .join('');
    return (
        `<p class="ticket-hub-analytics-panel-hint">${analyticsEscapeHtml(title)}</p>` +
        `<div class="ticket-hub-analytics-bars">${bars}</div>`
    );
}

function renderAnalyticsTopJobs(topJobs) {
    if (!topJobs || !topJobs.length) {
        return '<div class="ticket-hub-analytics-muted">No projects with tickets yet.</div>';
    }
    const rows = topJobs
        .slice(0, 8)
        .map(
            ([name, count]) =>
                `<tr><td>${analyticsEscapeHtml(name)}</td><td class="ticket-hub-analytics-num">${count}</td></tr>`
        )
        .join('');
    return (
        '<table class="ticket-hub-analytics-mini-table">' +
        '<thead><tr><th scope="col">Project</th><th scope="col">Tickets</th></tr></thead>' +
        `<tbody>${rows}</tbody></table>`
    );
}

function renderResponseProgress(progress) {
    const complete = (progress && progress.complete) || 0;
    const partial = (progress && progress.partial) || 0;
    const none = (progress && progress.none) || 0;
    return (
        '<div class="ticket-hub-analytics-progress-grid">' +
        analyticsSummaryCard('All responded', complete, 'Received count meets or exceeds required') +
        analyticsSummaryCard('Partial', partial, 'Some utilities responded') +
        analyticsSummaryCard('None / unknown', none, 'Missing response counts or no responses') +
        '</div>'
    );
}

function renderAnalyticsLoading() {
    return (
        '<div class="ticket-hub-analytics-loading" role="status" aria-live="polite">' +
        '<span class="ticket-hub-analytics-spinner" aria-hidden="true"></span>' +
        '<span>Loading analytics…</span>' +
        '</div>'
    );
}

function renderAnalyticsControls(filters) {
    return (
        '<div class="ticket-hub-analytics-controls">' +
        '<label class="ticket-hub-analytics-control">' +
        '<span>From</span>' +
        `<input type="date" id="ticketHubAnalyticsFrom" value="${analyticsEscapeHtml(filters.from)}">` +
        '</label>' +
        '<label class="ticket-hub-analytics-control">' +
        '<span>To</span>' +
        `<input type="date" id="ticketHubAnalyticsTo" value="${analyticsEscapeHtml(filters.to)}">` +
        '</label>' +
        '<label class="ticket-hub-analytics-control">' +
        '<span>Date field</span>' +
        `<select id="ticketHubAnalyticsDateField">` +
        `<option value="lodged_on"${filters.dateField === 'lodged_on' ? ' selected' : ''}>Created on</option>` +
        `<option value="expires_at"${filters.dateField === 'expires_at' ? ' selected' : ''}>Expires at</option>` +
        '</select>' +
        '</label>' +
        '<button type="button" class="ticket-hub-analytics-btn" id="ticketHubAnalyticsRefresh">Refresh</button>' +
        '<button type="button" class="ticket-hub-analytics-btn ticket-hub-analytics-btn--secondary" id="ticketHubAnalyticsExport">Export CSV</button>' +
        '</div>'
    );
}

function wireAnalyticsControls(onRefresh) {
    const refreshBtn = document.getElementById('ticketHubAnalyticsRefresh');
    const exportBtn = document.getElementById('ticketHubAnalyticsExport');
    const fromEl = document.getElementById('ticketHubAnalyticsFrom');
    const toEl = document.getElementById('ticketHubAnalyticsTo');
    const fieldEl = document.getElementById('ticketHubAnalyticsDateField');

    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => onRefresh(true));
    }
    if (fromEl) fromEl.addEventListener('change', () => onRefresh(true));
    if (toEl) toEl.addEventListener('change', () => onRefresh(true));
    if (fieldEl) fieldEl.addEventListener('change', () => onRefresh(true));
    if (exportBtn) {
        exportBtn.addEventListener('click', async () => {
            const api = analyticsApiBase();
            if (!api.orgId || !window.authModule) return;
            const filters = readAnalyticsFiltersFromDom();
            const qs = analyticsQueryString(filters);
            const base =
                window.authModule.API_BASE != null ? String(window.authModule.API_BASE) : '/api';
            const url = `${base}/tickets/analytics/export.csv${qs}`;
            const headers =
                typeof window.authModule.getAuthHeaders === 'function'
                    ? window.authModule.getAuthHeaders()
                    : { Authorization: `Bearer ${localStorage.getItem('authToken') || ''}` };
            try {
                const res = await fetch(url, { headers });
                if (!res.ok) {
                    const text = await res.text();
                    throw new Error(text.slice(0, 200) || `HTTP ${res.status}`);
                }
                const blob = await res.blob();
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `ticket-analytics-${api.orgId}-${filters.from}-${filters.to}.csv`;
                a.click();
                URL.revokeObjectURL(a.href);
            } catch (e) {
                if (window.appAlert) window.appAlert((e && e.message) || 'Export failed');
            }
        });
    }
}

function renderAnalyticsContent(data, topProjects, filters) {
    const orgLabel = getAnalyticsOrgLabel();
    const rangeLabel = `${filters.from} → ${filters.to}`;
    const ackCount = (data.ackBlockers && data.ackBlockers.ticketCount) || 0;
    const pendingCount = (data.pendingUtility && data.pendingUtility.ticketCount) || 0;
    const lateCount = (data.lateResponses && data.lateResponses.ticketCount) || 0;

    return (
        '<header class="ticket-hub-analytics-header">' +
        '<h2 class="ticket-hub-analytics-title">Ticket analytics</h2>' +
        `<p class="ticket-hub-analytics-subtitle">Organization snapshot for <strong>${analyticsEscapeHtml(orgLabel)}</strong> — ${analyticsEscapeHtml(rangeLabel)} (server data).</p>` +
        renderAnalyticsControls(filters) +
        '</header>' +
        '<div class="ticket-hub-analytics-summary-grid">' +
        analyticsSummaryCard('Total tickets', data.ticketCount || 0, 'Tickets in selected date range') +
        analyticsSummaryCard('Active', data.activeCount || 0, 'Excludes expired and cancelled') +
        analyticsSummaryCard('Ack blockers', ackCount, 'Tickets with pending ack-blocking operator codes') +
        analyticsSummaryCard('Late (999)', lateCount, 'Utilities that did not respond by required time') +
        '</div>' +
        '<div class="ticket-hub-analytics-panels">' +
        '<section class="ticket-hub-analytics-panel">' +
        '<h3 class="ticket-hub-analytics-panel-title">Status breakdown</h3>' +
        renderAnalyticsStatusBreakdown(data.statusBreakdown) +
        '</section>' +
        '<section class="ticket-hub-analytics-panel">' +
        '<h3 class="ticket-hub-analytics-panel-title">Blocker codes</h3>' +
        renderCodeBreakdown(
            `${ackCount} ticket(s) with codes that block workflow acknowledgement.`,
            data.ackBlockers && data.ackBlockers.byCode,
            'No ack-blocking codes in this range.'
        ) +
        '</section>' +
        '<section class="ticket-hub-analytics-panel">' +
        '<h3 class="ticket-hub-analytics-panel-title">Pending utility</h3>' +
        renderCodeBreakdown(
            `${pendingCount} ticket(s) waiting on utilities (includes code 080 and incomplete response counts).` +
                (data.pendingUtility && data.pendingUtility.byCountRule
                    ? ` ${data.pendingUtility.byCountRule} by response count.`
                    : ''),
            data.pendingUtility && data.pendingUtility.byCode,
            'No pending utility codes in this range.'
        ) +
        '</section>' +
        '<section class="ticket-hub-analytics-panel">' +
        '<h3 class="ticket-hub-analytics-panel-title">Late responses</h3>' +
        `<p class="ticket-hub-analytics-panel-hint">${lateCount} ticket(s) with operator code 999 (did not respond by required time).</p>` +
        renderCodeBreakdown(
            'Late response rollup',
            lateCount > 0 ? { 999: (data.lateResponses && data.lateResponses.byCode999) || lateCount } : {},
            'No code 999 responses in this range.'
        ) +
        '</section>' +
        '<section class="ticket-hub-analytics-panel">' +
        '<h3 class="ticket-hub-analytics-panel-title">Response progress</h3>' +
        renderResponseProgress(data.responseProgress) +
        '</section>' +
        '<section class="ticket-hub-analytics-panel">' +
        '<h3 class="ticket-hub-analytics-panel-title">Top projects</h3>' +
        renderAnalyticsTopJobs(topProjects) +
        '</section>' +
        '</div>' +
        '<p class="ticket-hub-analytics-footnote">Based on server data for the selected date range. Analytics load when you open this tab.</p>'
    );
}

async function renderTicketHubAnalyticsSection(forceRefresh) {
    const root = document.getElementById('ticketHubAnalyticsContent');
    if (!root) return;
    if (!canViewTicketHubAnalytics()) {
        root.innerHTML =
            '<div class="ticket-hub-analytics-empty">Analytics are available to organization admins and developers.</div>';
        return;
    }

    const filters =
        document.getElementById('ticketHubAnalyticsFrom') != null
            ? readAnalyticsFiltersFromDom()
            : defaultAnalyticsDateRange();

    if (!forceRefresh) {
        const api = analyticsApiBase();
        const key = analyticsCacheKey(api.orgId, filters);
        if (analyticsSessionCache && analyticsSessionCache.key === key) {
            root.innerHTML = renderAnalyticsContent(
                analyticsSessionCache.data,
                analyticsSessionCache.topProjects,
                filters
            );
            wireAnalyticsControls((fr) => renderTicketHubAnalyticsSection(fr));
            return;
        }
    }

    root.innerHTML = renderAnalyticsLoading();

    if (typeof window.ensureOperatorResponseCodeCatalogLoaded === 'function') {
        await window.ensureOperatorResponseCodeCatalogLoaded();
    }

    const result = await fetchAnalyticsSummary(filters, !!forceRefresh);
    if (result.error) {
        root.innerHTML =
            `<div class="ticket-hub-analytics-empty">${analyticsEscapeHtml(result.error)}</div>`;
        return;
    }

    const activeFilters = readAnalyticsFiltersFromDom();
    root.innerHTML = renderAnalyticsContent(result.data, result.topProjects, activeFilters);
    wireAnalyticsControls((fr) => renderTicketHubAnalyticsSection(fr));
}

function syncTicketHubAnalyticsTabVisibility() {
    const tab = document.getElementById('ticketHubSectionTabAnalytics');
    const section = document.getElementById('ticketHubAnalyticsSection');
    const show = canViewTicketHubAnalytics();
    if (tab) tab.hidden = !show;
    if (!show) {
        if (section) section.setAttribute('hidden', '');
        const active =
            typeof window.getTicketHubActiveSection === 'function'
                ? window.getTicketHubActiveSection()
                : null;
        if (active === 'analytics' && typeof window.setTicketHubActiveSection === 'function') {
            window.setTicketHubActiveSection('tickets');
        }
    }
}

function redrawTicketHubAnalyticsIfOpen() {
    const win = document.getElementById('ticketHubWindow');
    if (!win || !win.classList.contains('show')) return;
    const active =
        typeof window.getTicketHubActiveSection === 'function'
            ? window.getTicketHubActiveSection()
            : null;
    if (active !== 'analytics') return;
    invalidateAnalyticsCache();
    renderTicketHubAnalyticsSection(true);
}

window.canViewTicketHubAnalytics = canViewTicketHubAnalytics;
window.syncTicketHubAnalyticsTabVisibility = syncTicketHubAnalyticsTabVisibility;
window.renderTicketHubAnalyticsSection = renderTicketHubAnalyticsSection;
window.redrawTicketHubAnalyticsIfOpen = redrawTicketHubAnalyticsIfOpen;
window.invalidateTicketHubAnalyticsCache = invalidateAnalyticsCache;
