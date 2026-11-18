'use strict';

let ticketHubActiveSection = 'tickets';
let selectedComplianceHubJobKey = null;
let complianceHubSearchQuery = '';
let complianceHubProjects = [];
let complianceHubProjectDetail = null;
let complianceHubProjectsLoading = false;
let complianceHubSectionTabsWired = false;
let complianceHubListMode = 'open';
let complianceHubUseDateRange = false;
let complianceHubDateRange = null;
let complianceHubClientPage = 1;

const COMPLIANCE_HUB_DATE_PRESET_DAYS = 90;
/** Client-side page size for the projects list (full set is already in memory). */
const COMPLIANCE_HUB_PAGE_SIZE = 30;

function formatComplianceHubDateIsoLocal(d) {
    const dt = d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date();
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function defaultComplianceHubDateRange() {
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - (COMPLIANCE_HUB_DATE_PRESET_DAYS - 1));
    return {
        from: formatComplianceHubDateIsoLocal(start),
        to: formatComplianceHubDateIsoLocal(today),
    };
}

function complianceHubProjectIsClosed(project) {
    return !!(project && String(project.status || '').trim().toLowerCase() === 'closed');
}

function complianceHubFiltersAreActive() {
    return complianceHubListMode === 'closed' || complianceHubUseDateRange;
}

function formatComplianceHubClosedDateLabel(iso) {
    if (!iso) return '';
    const d = new Date(String(iso));
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function buildComplianceHubProjectsQuery(api) {
    if (!api) return '';
    const base = api.q || '';
    const params = [`status=${encodeURIComponent(complianceHubListMode)}`];
    const needsDate =
        complianceHubListMode === 'closed' ||
        (complianceHubListMode === 'open' && complianceHubUseDateRange);
    if (needsDate) {
        const range = complianceHubDateRange || defaultComplianceHubDateRange();
        params.push(`from=${encodeURIComponent(range.from)}`);
        params.push(`to=${encodeURIComponent(range.to)}`);
    }
    const extra = params.join('&');
    return base ? `${base}&${extra}` : `?${extra}`;
}

function syncComplianceHubFilterDateInputs() {
    const range = complianceHubDateRange || defaultComplianceHubDateRange();
    const fromEl = document.getElementById('ticketHubComplianceFilterFrom');
    const toEl = document.getElementById('ticketHubComplianceFilterTo');
    if (fromEl) fromEl.value = range.from;
    if (toEl) toEl.value = range.to;
}

function syncComplianceHubFilterDateHint() {
    const hint = document.getElementById('ticketHubComplianceFilterDateHint');
    if (!hint) return;
    if (complianceHubListMode === 'closed') {
        hint.textContent = 'Closed list uses the date the project was closed.';
    } else {
        hint.textContent =
            'Active list uses the latest ticket update or compliance change in the range.';
    }
}

function syncComplianceHubFiltersUi() {
    if (complianceHubIsTechViewer()) {
        complianceHubListMode = 'open';
    }
    const openRadio = document.querySelector(
        'input[name="ticketHubComplianceListMode"][value="open"]'
    );
    const closedRadio = document.querySelector(
        'input[name="ticketHubComplianceListMode"][value="closed"]'
    );
    const closedLabel = closedRadio ? closedRadio.closest('label') : null;
    const useDate = document.getElementById('ticketHubComplianceUseDateRange');
    const rangePanel = document.getElementById('ticketHubComplianceFilterDateRange');
    const filtersBtn = document.getElementById('ticketHubComplianceFiltersOpenBtn');
    if (openRadio) openRadio.checked = complianceHubListMode === 'open';
    if (closedRadio) {
        closedRadio.checked = complianceHubListMode === 'closed';
        closedRadio.disabled = complianceHubIsTechViewer();
    }
    if (closedLabel) closedLabel.hidden = complianceHubIsTechViewer();
    if (useDate) {
        useDate.checked = complianceHubUseDateRange || complianceHubListMode === 'closed';
        useDate.disabled = complianceHubListMode === 'closed' || complianceHubIsTechViewer();
    }
    const showRange =
        !complianceHubIsTechViewer() &&
        (complianceHubListMode === 'closed' ||
            (complianceHubListMode === 'open' && complianceHubUseDateRange));
    if (rangePanel) rangePanel.hidden = !showRange;
    if (showRange) syncComplianceHubFilterDateInputs();
    syncComplianceHubFilterDateHint();
    if (filtersBtn) {
        filtersBtn.classList.toggle(
            'ticket-hub-compliance-filters-btn--active',
            complianceHubFiltersAreActive()
        );
    }
}

function resetComplianceHubFilters() {
    complianceHubListMode = 'open';
    complianceHubUseDateRange = false;
    complianceHubDateRange = null;
    syncComplianceHubFiltersUi();
}

function complianceHubApiBase() {
    const base =
        window.authModule && window.authModule.API_BASE ? String(window.authModule.API_BASE) : '/api';
    let orgId = null;
    if (window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function') {
        orgId = window.orgSelectorModule.getCurrentOrgId();
    } else if (window.authModule && window.authModule.getCurrentUser) {
        const u = window.authModule.getCurrentUser();
        orgId = u && u.organizationId;
    }
    const q = orgId != null ? `?organizationId=${encodeURIComponent(String(orgId))}` : '';
    return { base, q, orgId };
}

function escapeComplianceHubHtml(s) {
    if (typeof hubEscapeHtml === 'function') return hubEscapeHtml(s);
    if (typeof escapeHtmlTicketUi === 'function') return escapeHtmlTicketUi(s);
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function complianceHubStatusLabel(project) {
    if (!project) return '—';
    if (complianceHubProjectIsClosed(project)) {
        const closedLabel = formatComplianceHubClosedDateLabel(project.closedAt);
        return closedLabel ? `Closed · ${closedLabel}` : 'Closed';
    }
    if (project.attentionRequired) return 'Needs attention';
    if (project.isRegisteredProject || (project.ticketCount > 0)) return 'Up to date';
    return 'No tickets yet';
}

function complianceHubStatusClass(project) {
    if (!project) return 'ticket-hub-compliance-status--unknown';
    if (complianceHubProjectIsClosed(project)) return 'ticket-hub-compliance-status--closed';
    if (project.attentionRequired) return 'ticket-hub-compliance-status--attention';
    if (project.isRegisteredProject || (project.ticketCount > 0)) return 'ticket-hub-compliance-status--ok';
    return 'ticket-hub-compliance-status--unknown';
}

function compareComplianceHubProjectsByName(a, b) {
    const nameA = a && a.jobName != null ? String(a.jobName) : '';
    const nameB = b && b.jobName != null ? String(b.jobName) : '';
    return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
}

function getFilteredComplianceHubProjects() {
    const q = complianceHubSearchQuery.trim().toLowerCase();
    const rows = Array.isArray(complianceHubProjects) ? complianceHubProjects : [];
    const filtered = !q
        ? rows.slice()
        : rows.filter((p) => p.jobName && String(p.jobName).toLowerCase().includes(q));
    filtered.sort(compareComplianceHubProjectsByName);
    return filtered;
}

function clampComplianceHubClientPage(total) {
    const totalPages = Math.max(1, Math.ceil((total || 0) / COMPLIANCE_HUB_PAGE_SIZE));
    if (complianceHubClientPage > totalPages) complianceHubClientPage = totalPages;
    if (complianceHubClientPage < 1) complianceHubClientPage = 1;
    return totalPages;
}

function getComplianceHubProjectsPageSlice(filtered) {
    const rows = Array.isArray(filtered) ? filtered : [];
    const totalPages = clampComplianceHubClientPage(rows.length);
    const start = (complianceHubClientPage - 1) * COMPLIANCE_HUB_PAGE_SIZE;
    return {
        pageRows: rows.slice(start, start + COMPLIANCE_HUB_PAGE_SIZE),
        total: rows.length,
        totalPages,
        page: complianceHubClientPage,
    };
}

function ensureComplianceHubPageContainsJob(jobKey) {
    if (!jobKey) return;
    const filtered = getFilteredComplianceHubProjects();
    const idx = filtered.findIndex((p) => p.jobNameKey === jobKey);
    if (idx < 0) return;
    complianceHubClientPage = Math.floor(idx / COMPLIANCE_HUB_PAGE_SIZE) + 1;
}

function scrollComplianceHubJobsToTop() {
    const scrollEl = document.querySelector('#ticketHubWindow .ticket-hub-compliance-jobs-scroll');
    if (window.overlayScrollModule && typeof window.overlayScrollModule.scrollToTop === 'function') {
        window.overlayScrollModule.scrollToTop(scrollEl);
        return;
    }
    if (scrollEl) {
        scrollEl.scrollTop = 0;
        scrollEl.scrollLeft = 0;
    }
}

function updateComplianceHubProjectsPager(slice) {
    const pager = document.getElementById('ticketHubCompliancePager');
    const prevBtn = document.getElementById('ticketHubCompliancePrev');
    const nextBtn = document.getElementById('ticketHubComplianceNext');
    const pageLabel = document.getElementById('ticketHubCompliancePageLabel');
    if (!pager) return;
    const total = slice && typeof slice.total === 'number' ? slice.total : 0;
    const totalPages = slice && slice.totalPages != null ? slice.totalPages : 1;
    const page = slice && slice.page != null ? slice.page : 1;
    pager.hidden = total <= 0;
    if (prevBtn) prevBtn.disabled = page <= 1;
    if (nextBtn) nextBtn.disabled = page >= totalPages;
    if (pageLabel) pageLabel.textContent = `Page ${page} / ${totalPages}`;
}

function findComplianceHubProject(jobKey) {
    return (complianceHubProjects || []).find((p) => p.jobNameKey === jobKey) || null;
}

function renderComplianceHubJobsTable() {
    const body = document.getElementById('ticketHubComplianceJobsBody');
    const emptyEl = document.getElementById('ticketHubComplianceJobsEmpty');
    if (!body) return;
    if (complianceHubProjectsLoading) {
        body.innerHTML =
            '<tr><td colspan="3"><p class="ticket-hub-compliance-loading-row">Loading projects…</p></td></tr>';
        if (emptyEl) emptyEl.hidden = true;
        updateComplianceHubProjectsPager({ total: 0, totalPages: 1, page: 1 });
        return;
    }
    const projects = getFilteredComplianceHubProjects();
    if (!projects.length) {
        body.innerHTML = '';
        if (emptyEl) {
            emptyEl.hidden = false;
            if (complianceHubSearchQuery.trim()) {
                emptyEl.textContent = 'No projects match your search.';
            } else if (complianceHubListMode === 'closed') {
                emptyEl.textContent = 'No closed projects in this date range.';
            } else if (complianceHubUseDateRange) {
                emptyEl.textContent = 'No active projects with activity in this date range.';
            } else {
                emptyEl.textContent =
                    'No projects yet. Create a project to reserve a job name before tickets arrive from USAN.';
            }
        }
        updateComplianceHubProjectsPager({ total: 0, totalPages: 1, page: 1 });
        return;
    }
    if (emptyEl) emptyEl.hidden = true;
    const slice = getComplianceHubProjectsPageSlice(projects);
    updateComplianceHubProjectsPager(slice);
    body.innerHTML = slice.pageRows
        .map((project) => {
            const selected =
                project.jobNameKey === selectedComplianceHubJobKey
                    ? ' ticket-hub-compliance-job-row--selected'
                    : '';
            const statusClass = complianceHubStatusClass(project);
            const statusText = complianceHubStatusLabel(project);
            return `<tr class="ticket-hub-compliance-job-row${selected}" data-compliance-hub-job-key="${escapeComplianceHubHtml(project.jobNameKey)}">
                <td class="ticket-hub-td-ellipsis" title="${escapeComplianceHubHtml(project.jobName)}">${escapeComplianceHubHtml(project.jobName)}</td>
                <td>${project.ticketCount || 0}</td>
                <td><span class="ticket-hub-compliance-status ${statusClass}">${escapeComplianceHubHtml(statusText)}</span></td>
            </tr>`;
        })
        .join('');
}

function renderComplianceHubDetailEmpty(message) {
    hideTicketHubProjectDetailModal();
    const panel = document.getElementById('ticketHubComplianceDetail');
    if (!panel) return;
    if (complianceHubIsMobile()) {
        panel.innerHTML = '';
        return;
    }
    panel.innerHTML = `<div class="ticket-hub-compliance-detail-empty">${escapeComplianceHubHtml(
        message || 'Select a project to view tickets and compliance.'
    )}</div>`;
}

function complianceHubIsMobile() {
    return typeof window !== 'undefined' && window.innerWidth <= 768;
}

function applyComplianceHubProjectSheetMobileHeight(sheet, mode) {
    if (!sheet) return;
    const full = mode === 'full';
    sheet.classList.remove('ticket-hub-detail-mobile-halfway', 'ticket-hub-detail-mobile-full');
    sheet.classList.add(full ? 'ticket-hub-detail-mobile-full' : 'ticket-hub-detail-mobile-halfway');
    sheet.style.height = full ? '100dvh' : '50dvh';
    sheet.style.maxHeight = full ? '100dvh' : '50dvh';
}

function clearComplianceHubProjectSheetMobileHeight(sheet) {
    if (!sheet) return;
    sheet.classList.remove('ticket-hub-detail-mobile-halfway', 'ticket-hub-detail-mobile-full');
    sheet.style.height = '';
    sheet.style.maxHeight = '';
}

function syncComplianceHubProjectDetailMobileHeightToggle() {
    const grab = document.getElementById('ticketHubProjectDetailMobileHeightGrab');
    const modal = document.getElementById('ticketHubProjectDetailModal');
    if (!grab || !modal) return;
    const sheet = modal.querySelector('.ticket-hub-detail-modal-sheet');
    if (!sheet || !complianceHubIsMobile() || !modal.classList.contains('ticket-hub-detail-modal-open')) {
        grab.hidden = true;
        grab.classList.remove('ticket-hub-mobile-height-grab--full');
        return;
    }
    grab.hidden = false;
    const isFull = sheet.classList.contains('ticket-hub-detail-mobile-full');
    const label = isFull ? 'Collapse project panel' : 'Expand project panel';
    grab.setAttribute('aria-label', label);
    grab.title = label;
    grab.classList.toggle('ticket-hub-mobile-height-grab--full', isFull);
}

function toggleTicketHubProjectDetailMobileHeight() {
    const modal = document.getElementById('ticketHubProjectDetailModal');
    if (!modal || !complianceHubIsMobile()) return;
    const sheet = modal.querySelector('.ticket-hub-detail-modal-sheet');
    if (!sheet) return;
    const toFull = !sheet.classList.contains('ticket-hub-detail-mobile-full');
    applyComplianceHubProjectSheetMobileHeight(sheet, toFull ? 'full' : 'half');
    syncComplianceHubProjectDetailMobileHeightToggle();
}

function openTicketHubProjectDetailModal(projectTitle) {
    const modal = document.getElementById('ticketHubProjectDetailModal');
    if (!modal) return;
    const sheet = modal.querySelector('.ticket-hub-detail-modal-sheet');
    if (sheet && complianceHubIsMobile()) {
        applyComplianceHubProjectSheetMobileHeight(sheet, 'half');
    }
    modal.classList.add('ticket-hub-detail-modal-open');
    modal.setAttribute('aria-hidden', 'false');
    const titleEl = document.getElementById('ticketHubProjectDetailModalTitle');
    if (titleEl) {
        titleEl.textContent =
            projectTitle != null && String(projectTitle).trim() !== ''
                ? String(projectTitle).trim()
                : 'Project';
    }
    syncComplianceHubProjectDetailMobileHeightToggle();
}

function hideTicketHubProjectDetailModal() {
    const modal = document.getElementById('ticketHubProjectDetailModal');
    if (!modal) return;
    modal.classList.remove('ticket-hub-detail-modal-open');
    modal.setAttribute('aria-hidden', 'true');
    const inner = document.getElementById('ticketHubProjectDetailModalInner');
    if (inner) inner.innerHTML = '';
    const sheet = modal.querySelector('.ticket-hub-detail-modal-sheet');
    clearComplianceHubProjectSheetMobileHeight(sheet);
    syncComplianceHubProjectDetailMobileHeightToggle();
}

function closeTicketHubProjectDetailModal() {
    hideTicketHubProjectDetailModal();
    if (!complianceHubIsMobile()) return;
    selectedComplianceHubJobKey = null;
    complianceHubProjectDetail = null;
    renderComplianceHubJobsTable();
    const panel = document.getElementById('ticketHubComplianceDetail');
    if (panel) panel.innerHTML = '';
}

function getComplianceHubProjectDetailTarget() {
    if (complianceHubIsMobile()) {
        return document.getElementById('ticketHubProjectDetailModalInner');
    }
    return document.getElementById('ticketHubComplianceDetail');
}

function complianceHubDetailBodyEl(panel) {
    if (!panel) return null;
    const body = panel.querySelector('.ticket-hub-compliance-detail-body');
    return body || panel;
}

function complianceHubJobKeyFromPanel(panel) {
    const body = complianceHubDetailBodyEl(panel);
    const fromAttr = body && body.getAttribute('data-compliance-hub-job-key');
    if (fromAttr) return fromAttr;
    if (complianceHubProjectDetail && complianceHubProjectDetail.jobNameKey != null) {
        return String(complianceHubProjectDetail.jobNameKey);
    }
    return null;
}

function buildComplianceHubProjectStatusActionsHtml(detail) {
    if (!detail || !detail.jobNameKey) return '';
    if (!complianceHubCanEditProjects()) return '';
    const isClosed = complianceHubProjectIsClosed(detail);
    const action = isClosed ? 'open' : 'closed';
    const label = isClosed ? 'Reopen project' : 'Close project';
    const variant = isClosed ? 'reopen' : 'close';
    return `<div class="ticket-hub-compliance-detail-actions">
        <button type="button" class="ticket-hub-compliance-project-status-btn ticket-hub-compliance-project-status-btn--${variant}" data-compliance-hub-project-status="${action}">${escapeComplianceHubHtml(label)}</button>
    </div>`;
}

function buildComplianceHubProjectClosedBannerHtml(detail) {
    if (!detail || !complianceHubProjectIsClosed(detail)) return '';
    const closedLabel = formatComplianceHubClosedDateLabel(detail.closedAt);
    const closerName =
        detail.closedByDisplayName != null && String(detail.closedByDisplayName).trim() !== ''
            ? String(detail.closedByDisplayName).trim()
            : '';
    const when = closedLabel ? ` on ${closedLabel}` : '';
    const closer = closerName ? ` by ${escapeComplianceHubHtml(closerName)}` : '';
    return `<p class="ticket-hub-compliance-closed-banner">This project is closed${when}${closer}. It is hidden from the default project list until reopened.</p>`;
}

function complianceHubIsTechViewer() {
    return !!(
        window.authModule &&
        typeof window.authModule.isTechInCurrentOrg === 'function' &&
        window.authModule.isTechInCurrentOrg()
    );
}

function complianceHubCanEditProjectAssignees() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    if (!window.authModule || !window.authModule.isAuthenticated()) return false;
    if (complianceHubIsTechViewer()) return false;
    if (typeof window.canEditCurrentOrg === 'function' && !window.canEditCurrentOrg()) return false;
    return true;
}

function complianceHubCanEditProjects() {
    return complianceHubCanEditProjectAssignees();
}

function complianceHubIsOrgAdmin() {
    return !!(window.authModule && typeof window.authModule.isAdmin === 'function' && window.authModule.isAdmin());
}

function complianceHubInfoButtonHtml(title, message) {
    if (typeof window.buildAppInfoButtonHtml === 'function') {
        return window.buildAppInfoButtonHtml(title, message);
    }
    return '';
}

function buildComplianceHubShareLinkSectionHtml() {
    if (window.CORE_PRODUCT === true) return '';
    if (complianceHubIsTechViewer()) return '';
    if (!complianceHubIsOrgAdmin()) return '';
    const shareInfo = complianceHubInfoButtonHtml(
        'Public share link',
        'Anyone with the link can view tickets, maps, and photos on a read-only page. Compliance and notes are not included. The project ID in the URL stays the same when you disable and re-enable sharing.'
    );
    return `<section class="ticket-hub-project-share" data-compliance-hub-share-section>
        <div class="ticket-hub-project-section-head">
            <h4 class="ticket-hub-project-section-title">Public share link</h4>
            ${shareInfo}
        </div>
        <div class="ticket-hub-project-share-status" data-compliance-hub-share-status>Loading share link…</div>
        <div class="ticket-hub-project-share-actions">
            <button type="button" class="ticket-hub-action-btn ticket-hub-action-primary" data-compliance-hub-share-create>Enable sharing</button>
            <button type="button" class="ticket-hub-action-btn" data-compliance-hub-share-copy hidden>Copy link</button>
            <button type="button" class="ticket-hub-action-btn" data-compliance-hub-share-revoke hidden>Disable sharing</button>
        </div>
    </section>`;
}

function complianceHubProjectAssigneeCount(detail) {
    if (!detail) return 0;
    if (detail.assigneeCount != null && Number.isFinite(Number(detail.assigneeCount))) {
        return Math.max(0, Number(detail.assigneeCount));
    }
    return Array.isArray(detail.assignees) ? detail.assignees.length : 0;
}

function complianceHubAssigneeCountLabel(count) {
    if (typeof window.formatAssigneeCountLabel === 'function') {
        return window.formatAssigneeCountLabel(count);
    }
    const n = Number(count);
    if (!Number.isFinite(n) || n <= 0) return '0 Users';
    if (n === 1) return '1 User';
    return `${n} Users`;
}

function buildComplianceHubAssigneesHeaderControlHtml(detail) {
    const count = complianceHubProjectAssigneeCount(detail);
    const label = complianceHubAssigneeCountLabel(count);
    const canEdit = complianceHubCanEditProjectAssignees();
    const title = canEdit
        ? 'View or change who is assigned to this project'
        : 'People assigned to this project';
    return `<div class="ticket-hub-compliance-detail-assignees">
        <span class="ticket-hub-compliance-detail-assignees-label">Assignees</span>
        <button type="button" class="ticket-hub-assignee-count-btn" data-compliance-hub-assignees-open title="${escapeComplianceHubHtml(title)}">${escapeComplianceHubHtml(label)}</button>
    </div>`;
}

function buildComplianceHubProjectDetailBodyHtml(detail, project, ticketsHtml, complianceShell) {
    const jobKey = detail && detail.jobNameKey != null ? String(detail.jobNameKey) : '';
    const jobName = detail && detail.jobName != null ? String(detail.jobName) : '';
    const closedBanner = buildComplianceHubProjectClosedBannerHtml(detail);
    const statusActions = buildComplianceHubProjectStatusActionsHtml(detail);
    const shareSection = buildComplianceHubShareLinkSectionHtml();
    const assigneesControl = buildComplianceHubAssigneesHeaderControlHtml(detail);
    const canEdit = complianceHubCanEditProjectAssignees();
    const ticketsJoinInfo = canEdit
        ? complianceHubInfoButtonHtml(
              'How tickets join',
              "Tickets join automatically when their USAN job name matches, or you can add them on the map. Removing a ticket also detaches it from this project's shared compliance."
          )
        : '';
    const subtitleHtml = canEdit
        ? ''
        : '<p class="ticket-hub-compliance-detail-subtitle">Tickets in this project that you are assigned to.</p>';
    const usanImportInfo = complianceHubInfoButtonHtml(
        'Automatic ticket import',
        `USAN tickets with job name "${jobName}" are added to this project automatically on import.`
    );
    return `<div class="ticket-hub-compliance-detail-body" data-compliance-hub-job-key="${escapeComplianceHubHtml(jobKey)}">
        <div class="ticket-hub-compliance-detail-header">
            <div class="ticket-hub-compliance-detail-header-row">
                <div class="ticket-hub-compliance-detail-title-wrap">
                    <h3 class="ticket-hub-compliance-detail-title">${escapeComplianceHubHtml(detail.jobName)}</h3>
                    ${ticketsJoinInfo}
                </div>
                ${assigneesControl}
            </div>
            ${subtitleHtml}
            ${closedBanner}
        </div>
        ${ticketsHtml}
        <section class="ticket-hub-project-compliance">
            <div class="ticket-hub-project-section-head">
                <h4 class="ticket-hub-project-section-title">Compliance</h4>
                ${usanImportInfo}
            </div>
            ${complianceShell}
        </section>
        ${shareSection}
        ${statusActions}
    </div>`;
}

function complianceHubTicketIdsMatch(a, b) {
    if (a == null || b == null) return false;
    return String(a) === String(b);
}

function complianceHubFindTicketInPools(ticketId, ticketNumber) {
    const pools = [
        window.HUB_RECENTLY_OPENED_TICKETS,
        window.HUB_COMBINED_TICKETS,
        window.HUB_ACTIVE_TICKETS,
        window.HUB_EXPIRED_TICKETS,
        window.ORG_TICKETS,
    ];
    for (let i = 0; i < pools.length; i++) {
        const list = pools[i];
        if (!Array.isArray(list)) continue;
        const found = list.find(
            (t) =>
                t &&
                (complianceHubTicketIdsMatch(t.id, ticketId) ||
                    (ticketNumber != null &&
                        ticketNumber !== '' &&
                        String(t.ticketNumber) === String(ticketNumber)))
        );
        if (found) return found;
    }
    return null;
}

function complianceHubTicketLooksExpired(ticket) {
    if (!ticket || typeof ticket !== 'object') return false;
    const exp =
        ticket.expiresAt ||
        ticket.ticketExpirationDate ||
        ticket.ticket_expires_at ||
        ticket.endTime ||
        null;
    if (!exp) return false;
    const parsed = new Date(exp);
    return !Number.isNaN(parsed.getTime()) && parsed.getTime() < Date.now();
}

function complianceHubEffectiveStatus(ticket) {
    if (
        window.ticketsModule &&
        typeof window.ticketsModule.getTicketWorkflowStatusForMap === 'function' &&
        ticket
    ) {
        const fromModule = window.ticketsModule.getTicketWorkflowStatusForMap(ticket);
        if (fromModule) return fromModule;
    }
    if (!ticket || typeof ticket !== 'object') return '';
    const raw =
        ticket.status ||
        ticket.workflowStatus ||
        ticket.computedWorkflowStatus ||
        ticket.workflow_status ||
        '';
    if (raw) {
        const s = String(raw).trim();
        if (s === 'REVIEW REQUIRED' || s.toUpperCase() === 'REVIEW REQUIRED') return 'ACTION_REQUIRED';
        return s.toUpperCase().replace(/\s+/g, '_');
    }
    if (complianceHubTicketLooksExpired(ticket)) return 'EXPIRED';
    return '';
}

function complianceHubStatusBadgeClass(status) {
    switch (status) {
        case 'READY':
            return 'ready';
        case 'NOT_READY':
            return 'not-ready';
        case 'ACTION_REQUIRED':
            return 'action-required';
        case 'EXPIRING_SOON':
            return 'expiring-soon';
        case 'EXPIRED':
            return 'expired';
        case 'CANCELLED':
            return 'cancelled';
        default:
            return 'expired';
    }
}

function buildComplianceHubTicketStatusBadgeHtml(ticket) {
    const status = complianceHubEffectiveStatus(ticket);
    if (!status) {
        return '<span class="ticket-hub-td-muted">—</span>';
    }
    const statusCls = complianceHubStatusBadgeClass(status);
    const label =
        typeof window.formatWorkflowStatusDisplay === 'function'
            ? window.formatWorkflowStatusDisplay(status)
            : String(status).replace(/_/g, ' ');
    const fallback = `<span class="ticket-card-status ${statusCls}">${escapeComplianceHubHtml(label)}</span>`;
    const wm = window.workflowAckModule;
    if (wm && typeof wm.preferCoreStatusIndicatorHtml === 'function') {
        return wm.preferCoreStatusIndicatorHtml(status, fallback);
    }
    return fallback;
}

function resolveComplianceHubTicketFromSummary(summary) {
    if (!summary) return null;
    const id = summary.id;
    const ticketNumber = summary.ticketNumber;
    const fromPools = complianceHubFindTicketInPools(id, ticketNumber);
    if (fromPools) return fromPools;
    return summary;
}

function buildComplianceHubTicketsListHtml(detail) {
    let tickets = detail && Array.isArray(detail.tickets) ? detail.tickets : [];
    if (complianceHubIsTechViewer()) {
        tickets = tickets.filter((summary) => {
            const ticket = resolveComplianceHubTicketFromSummary(summary);
            if (!ticket) return false;
            if (typeof window.isTicketVisibleToTechClient === 'function') {
                return window.isTicketVisibleToTechClient(ticket);
            }
            if (ticket.shared) return false;
            return !complianceHubTicketLooksExpired(ticket);
        });
    }
    const canEdit = complianceHubCanEditProjectAssignees();
    const addBtn = canEdit
        ? `<button type="button" class="ticket-hub-action-btn ticket-hub-project-add-ticket-btn" data-compliance-hub-add-ticket>Add tickets on map</button>`
        : '';
    if (!tickets.length) {
        return `<section class="ticket-hub-project-tickets">
            <div class="ticket-hub-project-tickets-header">
                <h4 class="ticket-hub-project-section-title">Tickets</h4>
                ${addBtn}
            </div>
            <p class="ticket-hub-project-tickets-empty">No tickets yet. Add tickets on the map or import USAN tickets with a matching job name.</p>
        </section>`;
    }
    const rows = tickets
        .map((summary) => {
            const ticket = resolveComplianceHubTicketFromSummary(summary);
            const tn =
                summary.ticketNumber != null
                    ? String(summary.ticketNumber)
                    : ticket && ticket.ticketNumber != null
                      ? String(ticket.ticketNumber)
                      : '';
            const address =
                summary.address != null && String(summary.address).trim() !== ''
                    ? String(summary.address).trim()
                    : ticket && ticket.address != null
                      ? String(ticket.address).trim()
                      : '';
            const statusBadge = buildComplianceHubTicketStatusBadgeHtml(ticket);
            const ticketId = summary.id != null ? String(summary.id) : ticket && ticket.id != null ? String(ticket.id) : '';
            const membershipBadge =
                summary.membershipSource === 'manual_include'
                    ? '<span class="ticket-hub-project-membership-badge">Manual</span>'
                    : '<span class="ticket-hub-project-membership-badge ticket-hub-project-membership-badge--auto">Auto</span>';
            const removeBtn =
                canEdit && ticketId
                    ? `<button type="button" class="ticket-hub-project-ticket-remove" data-compliance-hub-remove-ticket="${escapeComplianceHubHtml(ticketId)}" data-compliance-hub-membership-source="${escapeComplianceHubHtml(summary.membershipSource || 'auto')}" title="Remove from project" aria-label="Remove from project">&times;</button>`
                    : '';
            return `<div class="ticket-hub-project-ticket-row" role="row" tabindex="0" data-compliance-hub-ticket-id="${escapeComplianceHubHtml(ticketId)}"${
                tn ? ` data-compliance-hub-ticket-number="${escapeComplianceHubHtml(tn)}"` : ''
            }>
                <span class="ticket-hub-project-ticket-num" role="cell">${escapeComplianceHubHtml(tn)}</span>
                <span class="ticket-hub-project-ticket-address" role="cell" title="${escapeComplianceHubHtml(address)}">${escapeComplianceHubHtml(address || '—')}</span>
                <span class="ticket-hub-project-ticket-membership" role="cell">${membershipBadge}</span>
                <span class="ticket-hub-project-ticket-status" role="cell">${statusBadge}${removeBtn}</span>
            </div>`;
        })
        .join('');
    return `<section class="ticket-hub-project-tickets">
        <div class="ticket-hub-project-tickets-header">
            <h4 class="ticket-hub-project-section-title">Tickets (${tickets.length})</h4>
            ${addBtn}
        </div>
        <div class="ticket-hub-project-tickets-scroll app-overlay-scroll">
            <div class="ticket-hub-project-tickets-grid" role="table">
                <div class="ticket-hub-project-tickets-grid-head" role="row">
                    <div role="columnheader">Ticket #</div>
                    <div role="columnheader">Address</div>
                    <div role="columnheader">Source</div>
                    <div role="columnheader">Status</div>
                </div>
                ${rows}
            </div>
        </div>
    </section>`;
}

async function fetchComplianceHubProjectDetail(jobKey) {
    const api = complianceHubApiBase();
    if (!api || !window.authModule || !window.authModule.apiRequest || !jobKey) return null;
    return window.authModule.apiRequest(
        `${api.base}/tickets/job-projects/${encodeURIComponent(jobKey)}${api.q}`
    );
}

async function loadComplianceHubProjects() {
    const api = complianceHubApiBase();
    if (!api || !window.authModule || !window.authModule.apiRequest) {
        complianceHubProjects = [];
        renderComplianceHubJobsTable();
        return;
    }
    complianceHubProjectsLoading = true;
    renderComplianceHubJobsTable();
    try {
        const query = buildComplianceHubProjectsQuery(api);
        const data = await window.authModule.apiRequest(
            `${api.base}/tickets/job-projects${query}`
        );
        complianceHubProjects = Array.isArray(data && data.projects) ? data.projects : [];
    } catch (_e) {
        complianceHubProjects = [];
    } finally {
        complianceHubProjectsLoading = false;
        renderComplianceHubJobsTable();
    }
}

function refreshComplianceHubProjectStatus(jobKey, data) {
    const attention = !!(data && data.attentionRequired);
    const idx = complianceHubProjects.findIndex((p) => p.jobNameKey === jobKey);
    if (idx >= 0) {
        complianceHubProjects[idx] = {
            ...complianceHubProjects[idx],
            attentionRequired: attention,
        };
    }
    if (complianceHubProjectDetail && complianceHubProjectDetail.jobNameKey === jobKey) {
        complianceHubProjectDetail.attentionRequired = attention;
    }
    renderComplianceHubJobsTable();
}

function attachComplianceHubProjectOverlayScrolls(container) {
    const mod = window.overlayScrollModule;
    if (!mod) return;
    if (typeof mod.attachOverlayScroll === 'function') {
        if (container && container.classList && container.classList.contains('app-overlay-scroll')) {
            mod.attachOverlayScroll(container);
        }
        if (container && typeof container.querySelectorAll === 'function') {
            container.querySelectorAll('.app-overlay-scroll').forEach((el) => {
                mod.attachOverlayScroll(el);
            });
        }
    }
    if (typeof mod.syncOverlayScroll === 'function' && container) {
        mod.syncOverlayScroll(container);
    }
}

async function renderComplianceHubProjectDetail(jobKey) {
    const panel = getComplianceHubProjectDetailTarget();
    const desktopPanel = document.getElementById('ticketHubComplianceDetail');
    if (!panel || !jobKey) return;
    panel.innerHTML =
        '<div class="ticket-hub-compliance-detail-empty">Loading project…</div>';
    if (complianceHubIsMobile() && desktopPanel && desktopPanel !== panel) {
        desktopPanel.innerHTML = '';
    }
    const detail = await fetchComplianceHubProjectDetail(jobKey);
    if (!detail) {
        renderComplianceHubDetailEmpty('Could not load this project.');
        return;
    }
    complianceHubProjectDetail = detail;
    if (typeof window.mergeTechVisibleTicketsFromProjectDetail === 'function') {
        window.mergeTechVisibleTicketsFromProjectDetail(detail);
        if (typeof window.renderHubTable === 'function') window.renderHubTable();
        if (typeof window.renderTickets === 'function') window.renderTickets();
    }
    const listProject = findComplianceHubProject(jobKey);
    const projectReadOnly = !complianceHubCanEditProjects();
    const project = {
        jobName: detail.jobName,
        jobNameKey: detail.jobNameKey,
        readOnly: projectReadOnly,
        attentionRequired: detail.attentionRequired,
        ticketCount: detail.ticketCount,
        isRegisteredProject: detail.isRegisteredProject,
        status: detail.status,
        closedAt: detail.closedAt,
        closedByDisplayName: detail.closedByDisplayName,
    };
    if (listProject) {
        listProject.ticketCount = detail.ticketCount;
        listProject.attentionRequired = detail.attentionRequired;
        listProject.status = detail.status;
        listProject.closedAt = detail.closedAt;
        listProject.closedByDisplayName = detail.closedByDisplayName;
        if (detail.assigneeCount != null) listProject.assigneeCount = detail.assigneeCount;
    }
    const ticketsHtml = buildComplianceHubTicketsListHtml(detail);
    const complianceShell =
        typeof window.buildProjectCompliancePanelShellHtml === 'function'
            ? window.buildProjectCompliancePanelShellHtml(project, { readOnly: projectReadOnly })
            : '<p class="job-compliance-empty">Compliance unavailable.</p>';
    const bodyHtml = buildComplianceHubProjectDetailBodyHtml(
        detail,
        project,
        ticketsHtml,
        complianceShell
    );
    if (complianceHubIsMobile()) {
        if (desktopPanel) desktopPanel.innerHTML = '';
        panel.innerHTML = bodyHtml;
        openTicketHubProjectDetailModal(detail.jobName);
    } else {
        hideTicketHubProjectDetailModal();
        panel.innerHTML = bodyHtml;
    }
    wireComplianceHubProjectTickets(panel);
    wireComplianceHubProjectTicketMutations(panel);
    wireComplianceHubProjectShareLink(panel);
    void wireComplianceHubProjectAssignees(panel, detail);
    attachComplianceHubProjectOverlayScrolls(panel);
    if (typeof window.loadJobComplianceForProject === 'function') {
        void window.loadJobComplianceForProject(project, panel).then(() => {
            attachComplianceHubProjectOverlayScrolls(panel);
        });
    }
    renderComplianceHubJobsTable();
}

function wireComplianceHubProjectStatusDelegation() {
    ['ticketHubComplianceDetail', 'ticketHubProjectDetailModal'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el || el.dataset.complianceHubStatusDelegate === '1') return;
        el.dataset.complianceHubStatusDelegate = '1';
        el.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-compliance-hub-project-status]');
            if (!btn || !el.contains(btn)) return;
            const nextStatus = btn.getAttribute('data-compliance-hub-project-status');
            if (!nextStatus || !complianceHubProjectDetail || !complianceHubProjectDetail.jobNameKey) return;
            void setComplianceHubProjectStatus(complianceHubProjectDetail.jobNameKey, nextStatus);
        });
    });
}

async function setComplianceHubProjectStatus(jobKey, nextStatus) {
    const api = complianceHubApiBase();
    if (!api || !window.authModule || !window.authModule.apiRequest || !jobKey) return;
    const isClose = String(nextStatus).trim().toLowerCase() === 'closed';
    if (isClose) {
        const ok =
            typeof window.appConfirm === 'function'
                ? await window.appConfirm(
                      'Close this project? It will be removed from the default project list. Tickets and compliance data are kept.'
                  )
                : window.confirm(
                      'Close this project? It will be removed from the default project list. Tickets and compliance data are kept.'
                  );
        if (!ok) return;
    }
    try {
        const detail = await window.authModule.apiRequest(
            `${api.base}/tickets/job-projects/${encodeURIComponent(jobKey)}/status${api.q}`,
            {
                method: 'PUT',
                body: JSON.stringify({ organizationId: api.orgId, status: isClose ? 'closed' : 'open' }),
            }
        );
        await loadComplianceHubProjects();
        if (typeof window.refreshProjectAssignmentIndex === 'function') {
            void window.refreshProjectAssignmentIndex({ force: true }).then(() => {
                if (typeof window.renderHubTable === 'function') window.renderHubTable();
                if (typeof window.renderTicketList === 'function') window.renderTicketList();
            });
        }
        if (isClose && complianceHubListMode === 'open') {
            selectedComplianceHubJobKey = null;
            complianceHubProjectDetail = null;
            renderComplianceHubJobsTable();
            renderComplianceHubDetailEmpty(
                'Project closed. Open Filters and choose Closed projects to view it in the archive.'
            );
            return;
        }
        const key =
            detail && detail.jobNameKey != null ? String(detail.jobNameKey) : String(jobKey);
        selectComplianceHubJob(key);
    } catch (err) {
        if (typeof window.appAlert === 'function') {
            void window.appAlert(err && err.message ? err.message : 'Failed to update project status.');
        }
    }
}

async function reopenClosedComplianceHubProject(jobNameKey, jobName) {
    const api = complianceHubApiBase();
    if (!api || !window.authModule || !window.authModule.apiRequest || !jobNameKey) return;
    const displayName = jobName != null && String(jobName).trim() !== '' ? String(jobName).trim() : jobNameKey;
    const ok =
        typeof window.appConfirm === 'function'
            ? await window.appConfirm(
                  `A closed project named “${displayName}” already exists. Reopen it?`
              )
            : window.confirm(
                  `A closed project named “${displayName}” already exists. Reopen it?`
              );
    if (!ok) return;
    complianceHubListMode = 'open';
    complianceHubUseDateRange = false;
    syncComplianceHubFiltersUi();
    await setComplianceHubProjectStatus(jobNameKey, 'open');
}

function findComplianceHubProjectTicketSummary(ticketId) {
    const detail = complianceHubProjectDetail;
    const tickets = detail && Array.isArray(detail.tickets) ? detail.tickets : [];
    return (
        tickets.find((s) => s && complianceHubTicketIdsMatch(s.id, ticketId)) || null
    );
}

/** In-flight project ticket opens keyed by ticket id (dedupe double-clicks). */
const complianceHubProjectTicketOpenInFlight = new Set();

async function openComplianceHubProjectTicket(ticketId, rowTicketNumber) {
    if (ticketId == null || ticketId === '') return;
    const idKey = String(ticketId);
    if (complianceHubProjectTicketOpenInFlight.has(idKey)) return;
    complianceHubProjectTicketOpenInFlight.add(idKey);

    const summary = findComplianceHubProjectTicketSummary(ticketId) || {
        id: ticketId,
        ticketNumber: rowTicketNumber || null,
    };
    if (
        (summary.ticketNumber == null || String(summary.ticketNumber).trim() === '') &&
        rowTicketNumber
    ) {
        summary.ticketNumber = rowTicketNumber;
    }
    const ticketNumber =
        summary.ticketNumber != null && String(summary.ticketNumber).trim() !== ''
            ? String(summary.ticketNumber).trim()
            : rowTicketNumber
              ? String(rowTicketNumber).trim()
              : '';

    try {
        if (complianceHubIsMobile()) {
            closeTicketHubProjectDetailModal();
        }
        if (typeof window.setTicketHubActiveSection === 'function') {
            window.setTicketHubActiveSection('tickets');
        }

        const already = complianceHubFindTicketInPools(ticketId, ticketNumber);
        const alreadyResponsesReady =
            already &&
            window.ticketsModule &&
            typeof window.ticketsModule.canShowTicketOperatorResponsesNow === 'function' &&
            window.ticketsModule.canShowTicketOperatorResponsesNow(already) &&
            !(
                typeof window.ticketsModule.shouldDeferPosrOperatorResponsesEmptyState === 'function' &&
                window.ticketsModule.shouldDeferPosrOperatorResponsesEmptyState(already)
            );
        // Slim expired/active pool hits must still hydrate when operator rows are missing.
        if (already && alreadyResponsesReady) {
            if (window.ticketHubModule && typeof window.ticketHubModule.selectRow === 'function') {
                window.ticketHubModule.selectRow(already.id != null ? already.id : ticketId);
            }
            return;
        }

        if (window.ticketHubModule && typeof window.ticketHubModule.beginPendingOpen === 'function') {
            window.ticketHubModule.beginPendingOpen(ticketId, { ticketNumber });
        }

        let resolved = null;
        if (window.ticketsModule && typeof window.ticketsModule.resolveTicketForOpen === 'function') {
            resolved = await window.ticketsModule.resolveTicketForOpen({
                ticketId,
                ticketNumber,
                summary: already || summary,
            });
        } else if (
            window.ticketsModule &&
            typeof window.ticketsModule.hydrateTicketFromDbDetail === 'function' &&
            ticketNumber
        ) {
            resolved = await window.ticketsModule.hydrateTicketFromDbDetail(
                already || { id: ticketId, ticketNumber },
                { parkInRecentlyOpened: true, addToOrgIfMissing: false }
            );
        }

        if (!resolved) {
            // Prefer the in-memory pool ticket over a hard failure when db-detail blips.
            resolved = already || null;
        }

        if (!resolved) {
            if (window.ticketHubModule && typeof window.ticketHubModule.failPendingOpen === 'function') {
                window.ticketHubModule.failPendingOpen(ticketId, 'load_failed');
            } else if (typeof window.appAlert === 'function') {
                void window.appAlert(
                    ticketNumber
                        ? `Could not load ticket ${ticketNumber}.`
                        : 'Could not load this ticket.'
                );
            }
            return;
        }

        if (window.ticketHubModule && typeof window.ticketHubModule.clearPendingOpen === 'function') {
            window.ticketHubModule.clearPendingOpen(ticketId);
        }

        if (window.ticketHubModule && typeof window.ticketHubModule.selectRow === 'function') {
            window.ticketHubModule.selectRow(resolved.id != null ? resolved.id : ticketId);
        }
    } finally {
        complianceHubProjectTicketOpenInFlight.delete(idKey);
    }
}

function wireComplianceHubProjectTickets(container) {
    const list = container.querySelector('.ticket-hub-project-tickets-grid');
    if (!list || list.dataset.complianceHubTicketsInit === '1') return;
    list.dataset.complianceHubTicketsInit = '1';
    const onActivate = (row) => {
        if (!row || !list.contains(row)) return;
        const ticketId = row.getAttribute('data-compliance-hub-ticket-id');
        if (!ticketId) return;
        const ticketNumber = row.getAttribute('data-compliance-hub-ticket-number') || '';
        void openComplianceHubProjectTicket(ticketId, ticketNumber);
    };
    list.addEventListener('click', (e) => {
        if (e.target.closest('[data-compliance-hub-remove-ticket]')) return;
        const row = e.target.closest('[data-compliance-hub-ticket-id]');
        onActivate(row);
    });
    list.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('[data-compliance-hub-ticket-id]');
        if (!row || !list.contains(row)) return;
        e.preventDefault();
        onActivate(row);
    });
}

function wireComplianceHubProjectTicketMutations(container) {
    if (!complianceHubCanEditProjects() || container.dataset.complianceHubTicketMutInit === '1') return;
    container.dataset.complianceHubTicketMutInit = '1';
    container.addEventListener('click', (e) => {
        const addBtn = e.target.closest('[data-compliance-hub-add-ticket]');
        if (addBtn && container.contains(addBtn)) {
            e.preventDefault();
            e.stopPropagation();
            void openComplianceHubAddTicketModal(container);
            return;
        }
        const removeBtn = e.target.closest('[data-compliance-hub-remove-ticket]');
        if (!removeBtn || !container.contains(removeBtn)) return;
        e.preventDefault();
        e.stopPropagation();
        const ticketId = removeBtn.getAttribute('data-compliance-hub-remove-ticket');
        const source = removeBtn.getAttribute('data-compliance-hub-membership-source') || 'auto';
        void removeComplianceHubProjectTicket(container, ticketId, source);
    });
}

async function openComplianceHubAddTicketModal(container) {
    const jobKey = complianceHubJobKeyFromPanel(container);
    if (!jobKey) return;
    const excluded = [];
    if (
        complianceHubProjectDetail &&
        complianceHubProjectDetail.jobNameKey === jobKey &&
        Array.isArray(complianceHubProjectDetail.tickets)
    ) {
        complianceHubProjectDetail.tickets.forEach((t) => {
            if (t && t.id != null) excluded.push(String(t.id));
        });
    }
    if (typeof window.startComplianceHubProjectMapPick === 'function') {
        await window.startComplianceHubProjectMapPick(jobKey, excluded);
        return;
    }
    if (typeof window.appAlert === 'function') {
        void window.appAlert('Map ticket selection is not available.');
    }
}

async function removeComplianceHubProjectTicket(container, ticketId, membershipSource) {
    const jobKey = complianceHubJobKeyFromPanel(container);
    if (!jobKey || !ticketId) return;
    const ok =
        typeof window.appConfirm === 'function'
            ? await window.appConfirm(
                  'Remove this ticket from the project? It will also be detached from shared compliance for this project.'
              )
            : window.confirm('Remove this ticket from the project?');
    if (!ok) return;
    const api = complianceHubApiBase();
    if (!api || !window.authModule || !window.authModule.apiRequest) return;
    const mode = membershipSource === 'manual_include' ? 'revert' : 'exclude';
    try {
        await window.authModule.apiRequest(
            `${api.base}/tickets/job-projects/${encodeURIComponent(jobKey)}/tickets/${encodeURIComponent(ticketId)}${api.q}`,
            {
                method: 'DELETE',
                body: JSON.stringify({ organizationId: api.orgId, mode }),
            }
        );
        await renderComplianceHubProjectDetail(jobKey);
        await loadComplianceHubProjects();
        if (typeof window.refreshProjectAssignmentIndex === 'function') {
            void window.refreshProjectAssignmentIndex({ force: true }).then(() => {
                if (typeof window.renderHubTable === 'function') window.renderHubTable();
                if (typeof window.renderTicketList === 'function') window.renderTicketList();
            });
        }
    } catch (err) {
        if (typeof window.appAlert === 'function') {
            void window.appAlert(err && err.message ? err.message : 'Failed to remove ticket');
        }
    }
}

function complianceHubShareUrlFromPath(sharePath) {
    const path = sharePath != null ? String(sharePath) : '';
    if (!path) return '';
    if (path.startsWith('http')) return path;
    const origin = typeof window !== 'undefined' && window.location ? window.location.origin : '';
    return origin ? `${origin}${path.startsWith('/') ? path : `/${path}`}` : path;
}

const PROJECT_ASSIGNEES_MODAL_PAGE_SIZE = 20;

let projectAssigneesModalJobKey = null;
let projectAssigneesModalBaselineSignature = null;
let projectAssigneesModalSkipDirtyOnClose = false;
let projectAssigneesModalUsers = [];
let projectAssigneesModalSearchQuery = '';
let projectAssigneesModalPage = 1;

function normalizeProjectAssigneesSearchQuery(value) {
    return String(value || '')
        .trim()
        .toLowerCase();
}

function getProjectAssigneesModalSignature(users) {
    const list = Array.isArray(users) ? users : projectAssigneesModalUsers;
    return list
        .map((user) => `${user.userId}:${user.checked ? '1' : '0'}`)
        .join('|');
}

function filterProjectAssigneesModalUsers(users, query) {
    const list = Array.isArray(users) ? users : [];
    const normalized = normalizeProjectAssigneesSearchQuery(query);
    if (!normalized) return list.slice();
    return list.filter((user) => user.displayName.toLowerCase().includes(normalized));
}

function paginateProjectAssigneesModalUsers(users, page) {
    const list = Array.isArray(users) ? users : [];
    const total = list.length;
    const totalPages = Math.max(1, Math.ceil(total / PROJECT_ASSIGNEES_MODAL_PAGE_SIZE) || 1);
    let safePage = Math.max(1, Math.floor(Number(page) || 1));
    if (safePage > totalPages) safePage = totalPages;
    const start = total === 0 ? 0 : (safePage - 1) * PROJECT_ASSIGNEES_MODAL_PAGE_SIZE;
    const pageItems = list.slice(start, start + PROJECT_ASSIGNEES_MODAL_PAGE_SIZE);
    return {
        pageItems,
        total,
        page: safePage,
        totalPages,
        rangeStart: total === 0 ? 0 : start + 1,
        rangeEnd: total === 0 ? 0 : start + pageItems.length,
    };
}

function renderProjectAssigneesModalPagination(slice) {
    const paginationEl = document.getElementById('projectAssigneesModalPagination');
    if (!paginationEl) return;
    if (!slice || slice.total === 0) {
        paginationEl.innerHTML = '';
        paginationEl.hidden = true;
        return;
    }
    paginationEl.hidden = slice.totalPages <= 1;
    if (paginationEl.hidden) {
        paginationEl.innerHTML = '';
        return;
    }
    const prevDisabled = slice.page <= 1 ? ' disabled' : '';
    const nextDisabled = slice.page >= slice.totalPages ? ' disabled' : '';
    paginationEl.innerHTML =
        '<span class="ticket-assignees-pagination-summary">Showing ' +
        slice.rangeStart +
        '–' +
        slice.rangeEnd +
        ' of ' +
        slice.total +
        '</span>' +
        '<span class="ticket-assignees-pagination-controls">' +
        '<button type="button" class="ticket-assignees-pagination-btn"' +
        prevDisabled +
        ' data-project-assignees-page="' +
        (slice.page - 1) +
        '">Previous</button>' +
        '<span>Page ' +
        slice.page +
        ' of ' +
        slice.totalPages +
        '</span>' +
        '<button type="button" class="ticket-assignees-pagination-btn"' +
        nextDisabled +
        ' data-project-assignees-page="' +
        (slice.page + 1) +
        '">Next</button>' +
        '</span>';
}

function renderProjectAssigneesModalChecklistView() {
    const container = document.getElementById('projectAssigneesModalChecklist');
    if (!container) return;
    const filtered = filterProjectAssigneesModalUsers(
        projectAssigneesModalUsers,
        projectAssigneesModalSearchQuery
    );
    const slice = paginateProjectAssigneesModalUsers(filtered, projectAssigneesModalPage);
    projectAssigneesModalPage = slice.page;
    container.innerHTML = '';
    if (!projectAssigneesModalUsers.length) {
        container.innerHTML = '<p class="ticket-hub-td-muted">No organization members found.</p>';
        renderProjectAssigneesModalPagination(null);
        return;
    }
    if (!filtered.length) {
        container.innerHTML = '<p class="ticket-hub-td-muted">No people match your search.</p>';
        renderProjectAssigneesModalPagination(slice);
        return;
    }
    slice.pageItems.forEach((user) => {
        const row = document.createElement('label');
        row.className = 'ticket-assignee-checkbox-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.userId = user.userId;
        cb.dataset.userName = user.displayName;
        cb.checked = !!user.checked;
        const span = document.createElement('span');
        span.className = 'ticket-assignee-checkbox-label';
        span.textContent = user.displayName;
        row.appendChild(cb);
        row.appendChild(span);
        container.appendChild(row);
    });
    renderProjectAssigneesModalPagination(slice);
}

function syncProjectAssigneesModalSaveButton() {
    const saveBtn = document.getElementById('projectAssigneesModalSaveBtn');
    if (!saveBtn) return;
    saveBtn.disabled =
        projectAssigneesModalBaselineSignature == null ||
        getProjectAssigneesModalSignature(projectAssigneesModalUsers) === projectAssigneesModalBaselineSignature;
}

function onProjectAssigneesModalChecklistChange(event) {
    const target = event && event.target;
    if (!target || target.type !== 'checkbox') return;
    const userId = target.dataset.userId != null ? String(target.dataset.userId) : '';
    if (!userId) return;
    const user = projectAssigneesModalUsers.find((entry) => entry.userId === userId);
    if (user) user.checked = !!target.checked;
    syncProjectAssigneesModalSaveButton();
}

function onProjectAssigneesModalSearchInput(event) {
    projectAssigneesModalSearchQuery =
        event && event.target ? String(event.target.value || '') : '';
    projectAssigneesModalPage = 1;
    renderProjectAssigneesModalChecklistView();
}

function onProjectAssigneesModalPaginationClick(event) {
    const button = event && event.target && event.target.closest
        ? event.target.closest('[data-project-assignees-page]')
        : null;
    if (!button || button.disabled) return;
    const nextPage = parseInt(button.getAttribute('data-project-assignees-page'), 10);
    if (!Number.isFinite(nextPage)) return;
    projectAssigneesModalPage = nextPage;
    renderProjectAssigneesModalChecklistView();
}

function resetProjectAssigneesModalEditorState() {
    projectAssigneesModalUsers = [];
    projectAssigneesModalSearchQuery = '';
    projectAssigneesModalPage = 1;
    const searchInput = document.getElementById('projectAssigneesModalSearch');
    if (searchInput) {
        searchInput.value = '';
        searchInput.oninput = null;
    }
    const paginationEl = document.getElementById('projectAssigneesModalPagination');
    if (paginationEl) {
        paginationEl.innerHTML = '';
        paginationEl.hidden = true;
        paginationEl.onclick = null;
    }
}

function refreshProjectAssigneeCountButton(detail) {
    if (!detail || !detail.jobNameKey) return;
    const count = complianceHubProjectAssigneeCount(detail);
    const label = complianceHubAssigneeCountLabel(count);
    const key = String(detail.jobNameKey);
    document.querySelectorAll('[data-compliance-hub-job-key]').forEach((root) => {
        if (root.getAttribute('data-compliance-hub-job-key') !== key) return;
        root.querySelectorAll('[data-compliance-hub-assignees-open]').forEach((btn) => {
            btn.textContent = label;
        });
    });
}

function renderProjectAssigneesModalReadOnlyList(assignees) {
    const listEl = document.getElementById('projectAssigneesModalList');
    if (!listEl) return;
    listEl.innerHTML = '';
    const users = Array.isArray(assignees) ? assignees : [];
    if (users.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ticket-assignees-empty';
        empty.textContent = 'No one assigned';
        listEl.appendChild(empty);
        return;
    }
    users.forEach((a) => {
        const row = document.createElement('label');
        row.className = 'ticket-assignee-checkbox-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.disabled = true;
        const span = document.createElement('span');
        span.className = 'ticket-assignee-checkbox-label';
        const label =
            a && a.userName != null && String(a.userName).trim() !== ''
                ? String(a.userName).trim()
                : a && a.userId != null
                  ? `User #${a.userId}`
                  : 'User';
        span.textContent = label;
        row.appendChild(cb);
        row.appendChild(span);
        listEl.appendChild(row);
    });
}

async function populateProjectAssigneesModalChecklist(detail) {
    const container = document.getElementById('projectAssigneesModalChecklist');
    const saveBtn = document.getElementById('projectAssigneesModalSaveBtn');
    const searchInput = document.getElementById('projectAssigneesModalSearch');
    const paginationEl = document.getElementById('projectAssigneesModalPagination');
    if (!container || !detail) return;
    const api = complianceHubApiBase();
    if (!api || !window.authModule || !window.authModule.apiRequest) return;
    const selected = new Set(
        (Array.isArray(detail.assignees) ? detail.assignees : [])
            .map((a) => (a && a.userId != null ? String(a.userId) : ''))
            .filter(Boolean)
    );
    resetProjectAssigneesModalEditorState();
    container.innerHTML = '<p class="ticket-hub-td-muted">Loading people…</p>';
    if (saveBtn) saveBtn.disabled = true;
    try {
        const users = await window.authModule.apiRequest(
            `${window.authModule.API_BASE}/users?organizationId=${encodeURIComponent(String(api.orgId))}`
        );
        const list = Array.isArray(users) ? users : [];
        projectAssigneesModalUsers = list
            .map((u) => {
                const userId = u && u.id != null ? String(u.id) : '';
                if (!userId) return null;
                return {
                    userId,
                    displayName: u.full_name || u.username || `User ${userId}`,
                    checked: selected.has(userId),
                };
            })
            .filter(Boolean);
        projectAssigneesModalSearchQuery = '';
        projectAssigneesModalPage = 1;
        if (searchInput) {
            searchInput.value = '';
            searchInput.oninput = onProjectAssigneesModalSearchInput;
        }
        if (paginationEl) {
            paginationEl.onclick = onProjectAssigneesModalPaginationClick;
        }
        container.onchange = onProjectAssigneesModalChecklistChange;
        renderProjectAssigneesModalChecklistView();
        projectAssigneesModalBaselineSignature = getProjectAssigneesModalSignature(projectAssigneesModalUsers);
        syncProjectAssigneesModalSaveButton();
    } catch (err) {
        container.innerHTML =
            '<p class="ticket-hub-td-muted">Could not load organization members.</p>';
        console.error('Project assignees modal:', err);
    }
}

async function openProjectAssigneesModal(detail) {
    if (!detail || !detail.jobNameKey) return;
    projectAssigneesModalJobKey = String(detail.jobNameKey);
    projectAssigneesModalSkipDirtyOnClose = false;
    const refEl = document.getElementById('projectAssigneesModalProjectRef');
    if (refEl) {
        refEl.textContent =
            detail.jobName != null && String(detail.jobName).trim() !== ''
                ? String(detail.jobName).trim()
                : projectAssigneesModalJobKey;
    }
    const canEdit = complianceHubCanEditProjectAssignees();
    const readOnly = document.getElementById('projectAssigneesModalReadOnly');
    const editor = document.getElementById('projectAssigneesModalEditor');
    if (canEdit) {
        if (readOnly) readOnly.style.display = 'none';
        if (editor) editor.style.display = 'block';
        await populateProjectAssigneesModalChecklist(detail);
    } else {
        if (readOnly) readOnly.style.display = 'block';
        if (editor) editor.style.display = 'none';
        renderProjectAssigneesModalReadOnlyList(detail.assignees);
    }
    const modal = document.getElementById('projectAssigneesModal');
    if (modal) {
        modal.style.display = 'flex';
        modal.classList.add('show');
    }
}

async function closeProjectAssigneesModal(opts) {
    const force = !!(opts && opts.force);
    if (!force && !projectAssigneesModalSkipDirtyOnClose && complianceHubCanEditProjectAssignees()) {
        if (
            projectAssigneesModalBaselineSignature != null &&
            getProjectAssigneesModalSignature(projectAssigneesModalUsers) !== projectAssigneesModalBaselineSignature
        ) {
            let discard = true;
            if (typeof window.appConfirm === 'function') {
                discard = await window.appConfirm('Discard unsaved assignment changes?');
            } else {
                discard = window.confirm('Discard unsaved assignment changes?');
            }
            if (!discard) return;
        }
    }
    projectAssigneesModalSkipDirtyOnClose = false;
    projectAssigneesModalBaselineSignature = null;
    projectAssigneesModalJobKey = null;
    const modal = document.getElementById('projectAssigneesModal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('show');
    }
    const checklist = document.getElementById('projectAssigneesModalChecklist');
    if (checklist) {
        checklist.innerHTML = '';
        checklist.onchange = null;
    }
    resetProjectAssigneesModalEditorState();
    const saveBtn = document.getElementById('projectAssigneesModalSaveBtn');
    if (saveBtn) saveBtn.disabled = true;
}

async function submitProjectAssigneesModalSave() {
    const jobKey = projectAssigneesModalJobKey;
    const saveBtn = document.getElementById('projectAssigneesModalSaveBtn');
    const api = complianceHubApiBase();
    if (!jobKey || !api || !window.authModule || !window.authModule.apiRequest) return;
    if (!complianceHubCanEditProjectAssignees()) return;
    const userIds = projectAssigneesModalUsers
        .filter((user) => user.checked)
        .map((user) => parseInt(user.userId, 10))
        .filter((id) => Number.isFinite(id));
    if (saveBtn) saveBtn.disabled = true;
    try {
        const data = await window.authModule.apiRequest(
            `${api.base}/tickets/job-projects/${encodeURIComponent(jobKey)}/assignees${api.q}`,
            {
                method: 'PUT',
                body: JSON.stringify({ organizationId: api.orgId, userIds }),
            }
        );
        const assignees = data && Array.isArray(data.assignees) ? data.assignees : [];
        const assigneeCount =
            data && data.assigneeCount != null ? data.assigneeCount : assignees.length;
        if (complianceHubProjectDetail && complianceHubProjectDetail.jobNameKey === jobKey) {
            complianceHubProjectDetail.assignees = assignees;
            complianceHubProjectDetail.assigneeCount = assigneeCount;
        }
        const listProject = findComplianceHubProject(jobKey);
        if (listProject) {
            listProject.assigneeCount = assigneeCount;
            listProject.assignees = assignees;
        }
        refreshProjectAssigneeCountButton({
            jobNameKey: jobKey,
            assignees,
            assigneeCount,
        });
        if (typeof window.clearTechVisibleTicketNumbersCache === 'function') {
            window.clearTechVisibleTicketNumbersCache();
        }
        if (typeof window.refreshProjectAssignmentIndex === 'function') {
            void window.refreshProjectAssignmentIndex({ force: true }).then(() => {
                if (typeof window.renderHubTable === 'function') window.renderHubTable();
                if (typeof window.renderTicketList === 'function') window.renderTicketList();
                if (typeof window.updateTicketDisplay === 'function') {
                    window.updateTicketDisplay();
                }
            });
        }
        if (typeof window.refreshTechVisibleTicketNumbers === 'function') {
            void window.refreshTechVisibleTicketNumbers().then(() => {
                if (typeof window.updateTicketDisplay === 'function') {
                    window.updateTicketDisplay();
                }
            });
        }
        projectAssigneesModalSkipDirtyOnClose = true;
        await closeProjectAssigneesModal();
    } catch (err) {
        syncProjectAssigneesModalSaveButton();
        if (typeof window.appAlert === 'function') {
            void window.appAlert(err && err.message ? err.message : 'Failed to save assignees.');
        }
    }
}

function wireComplianceHubProjectAssignees(container, detail) {
    if (!container || !detail || !detail.jobNameKey) return;
    const btn = container.querySelector('[data-compliance-hub-assignees-open]');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const current =
            complianceHubProjectDetail &&
            complianceHubProjectDetail.jobNameKey === detail.jobNameKey
                ? complianceHubProjectDetail
                : detail;
        void openProjectAssigneesModal(current);
    });
}

window.closeProjectAssigneesModal = closeProjectAssigneesModal;
window.submitProjectAssigneesModalSave = submitProjectAssigneesModalSave;
window.openProjectAssigneesModal = openProjectAssigneesModal;

async function loadComplianceHubShareLinkStatus(container) {
    const section = container.querySelector('[data-compliance-hub-share-section]');
    if (!section) return;
    const statusEl = section.querySelector('[data-compliance-hub-share-status]');
    const createBtn = section.querySelector('[data-compliance-hub-share-create]');
    const copyBtn = section.querySelector('[data-compliance-hub-share-copy]');
    const revokeBtn = section.querySelector('[data-compliance-hub-share-revoke]');
    const jobKey = complianceHubJobKeyFromPanel(container);
    const api = complianceHubApiBase();
    if (!api || !jobKey || !window.authModule || !window.authModule.apiRequest) return;
    try {
        const data = await window.authModule.apiRequest(
            `${api.base}/tickets/job-projects/${encodeURIComponent(jobKey)}/share-link${api.q}`
        );
        if (data && data.active && data.sharePath) {
            const url = complianceHubShareUrlFromPath(data.sharePath);
            if (statusEl) {
                statusEl.innerHTML = `Sharing is on.<br><code class="ticket-hub-share-url">${escapeComplianceHubHtml(url)}</code>`;
            }
            section.dataset.sharePath = data.sharePath;
            if (createBtn) createBtn.hidden = true;
            if (copyBtn) copyBtn.hidden = false;
            if (revokeBtn) revokeBtn.hidden = false;
        } else {
            const url = data && data.sharePath ? complianceHubShareUrlFromPath(data.sharePath) : '';
            if (statusEl) {
                statusEl.innerHTML = url
                    ? `Sharing is off. Re-enabling uses the same link.<br><code class="ticket-hub-share-url">${escapeComplianceHubHtml(url)}</code>`
                    : 'Sharing is off.';
            }
            section.dataset.sharePath = data && data.sharePath ? data.sharePath : '';
            if (createBtn) createBtn.hidden = false;
            if (copyBtn) copyBtn.hidden = !url;
            if (revokeBtn) revokeBtn.hidden = true;
        }
    } catch (_e) {
        if (statusEl) statusEl.textContent = 'Share link unavailable.';
    }
}

function wireComplianceHubProjectShareLink(container) {
    const section = container.querySelector('[data-compliance-hub-share-section]');
    if (!section || section.dataset.complianceHubShareInit === '1') return;
    section.dataset.complianceHubShareInit = '1';
    void loadComplianceHubShareLinkStatus(container);
    section.addEventListener('click', (e) => {
        const createBtn = e.target.closest('[data-compliance-hub-share-create]');
        const copyBtn = e.target.closest('[data-compliance-hub-share-copy]');
        const revokeBtn = e.target.closest('[data-compliance-hub-share-revoke]');
        const jobKey = complianceHubJobKeyFromPanel(container);
        const api = complianceHubApiBase();
        if (!api || !jobKey || !window.authModule || !window.authModule.apiRequest) return;
        if (createBtn) {
            void (async () => {
                try {
                    const data = await window.authModule.apiRequest(
                        `${api.base}/tickets/job-projects/${encodeURIComponent(jobKey)}/share-link${api.q}`,
                        { method: 'POST', body: JSON.stringify({ organizationId: api.orgId }) }
                    );
                    const url = complianceHubShareUrlFromPath(data && data.sharePath);
                    if (typeof window.appAlert === 'function') {
                        void window.appAlert(`Sharing enabled:\n${url}`);
                    }
                    await loadComplianceHubShareLinkStatus(container);
                } catch (err) {
                    if (typeof window.appAlert === 'function') {
                        void window.appAlert(err && err.message ? err.message : 'Failed to enable sharing');
                    }
                }
            })();
            return;
        }
        if (copyBtn) {
            const url = complianceHubShareUrlFromPath(section.dataset.sharePath);
            if (url && navigator.clipboard && navigator.clipboard.writeText) {
                void navigator.clipboard.writeText(url);
            } else if (typeof window.appAlert === 'function') {
                void window.appAlert(url || 'No link to copy');
            }
            return;
        }
        if (revokeBtn) {
            void (async () => {
                const ok =
                    typeof window.appConfirm === 'function'
                        ? await window.appConfirm(
                              'Disable sharing? The same link will work again if you re-enable later.'
                          )
                        : window.confirm(
                              'Disable sharing? The same link will work again if you re-enable later.'
                          );
                if (!ok) return;
                try {
                    await window.authModule.apiRequest(
                        `${api.base}/tickets/job-projects/${encodeURIComponent(jobKey)}/share-link${api.q}`,
                        { method: 'DELETE', body: JSON.stringify({ organizationId: api.orgId }) }
                    );
                    await loadComplianceHubShareLinkStatus(container);
                } catch (err) {
                    if (typeof window.appAlert === 'function') {
                        void window.appAlert(err && err.message ? err.message : 'Failed to disable sharing');
                    }
                }
            })();
        }
    });
}

function selectComplianceHubJob(jobKey) {
    selectedComplianceHubJobKey = jobKey || null;
    if (jobKey) ensureComplianceHubPageContainsJob(jobKey);
    renderComplianceHubJobsTable();
    if (!jobKey) {
        complianceHubProjectDetail = null;
        renderComplianceHubDetailEmpty();
        return;
    }
    void renderComplianceHubProjectDetail(jobKey);
}

async function createComplianceHubProject() {
    if (typeof window.setTicketHubActiveSection === 'function') {
        window.setTicketHubActiveSection('tickets');
    }
    const name =
        typeof window.appPrompt === 'function'
            ? await window.appPrompt('Please enter a name for this project. Name must match 811 ticket job name:', '')
            : window.prompt('Please enter a name for this project. Name must match 811 ticket job name:', '');
    const jobName = name != null ? String(name).trim() : '';
    if (!jobName) return;
    const api = complianceHubApiBase();
    if (!api || !window.authModule || !window.authModule.apiRequest) return;
    try {
        const detail = await window.authModule.apiRequest(`${api.base}/tickets/job-projects${api.q}`, {
            method: 'POST',
            body: JSON.stringify({ organizationId: api.orgId, jobName }),
        });
        await loadComplianceHubProjects();
        const key =
            detail && detail.jobNameKey != null
                ? String(detail.jobNameKey)
                : jobName.toLowerCase();
        selectComplianceHubJob(key);
    } catch (err) {
        if (err && (err.code === 'CLOSED_PROJECT_EXISTS' || err.errorCode === 'CLOSED_PROJECT_EXISTS')) {
            const key =
                err.jobNameKey != null && String(err.jobNameKey).trim() !== ''
                    ? String(err.jobNameKey).trim()
                    : jobName.toLowerCase();
            await reopenClosedComplianceHubProject(key, jobName);
            return;
        }
        if (typeof window.appAlert === 'function') {
            void window.appAlert(err && err.message ? err.message : 'Failed to create project.');
        }
    }
}

function wireComplianceHubJobsTable() {
    const body = document.getElementById('ticketHubComplianceJobsBody');
    if (!body || body.dataset.complianceHubJobsInit === '1') return;
    body.dataset.complianceHubJobsInit = '1';
    body.addEventListener('click', (e) => {
        const row = e.target.closest('[data-compliance-hub-job-key]');
        if (!row || !body.contains(row)) return;
        selectComplianceHubJob(row.getAttribute('data-compliance-hub-job-key'));
    });
}

async function reloadComplianceHubProjectsFromFilters() {
    if (complianceHubListMode === 'closed' && !complianceHubDateRange) {
        complianceHubDateRange = defaultComplianceHubDateRange();
        syncComplianceHubFilterDateInputs();
    }
    const prevKey = selectedComplianceHubJobKey;
    complianceHubClientPage = 1;
    await loadComplianceHubProjects();
    if (prevKey && !findComplianceHubProject(prevKey)) {
        selectedComplianceHubJobKey = null;
        complianceHubProjectDetail = null;
        renderComplianceHubDetailEmpty();
        renderComplianceHubJobsTable();
    } else if (prevKey) {
        ensureComplianceHubPageContainsJob(prevKey);
        renderComplianceHubJobsTable();
        await renderComplianceHubProjectDetail(prevKey);
    } else {
        renderComplianceHubJobsTable();
    }
}

function openTicketHubComplianceFiltersModal() {
    const modal = document.getElementById('ticketHubComplianceFiltersModal');
    if (!modal) return;
    if (complianceHubIsMobile()) {
        hideTicketHubProjectDetailModal();
    }
    syncComplianceHubFiltersUi();
    modal.classList.add('ticket-hub-detail-modal-open');
    modal.setAttribute('aria-hidden', 'false');
    const openBtn = document.getElementById('ticketHubComplianceFiltersOpenBtn');
    if (openBtn) openBtn.setAttribute('aria-expanded', 'true');
}

function closeTicketHubComplianceFiltersModal() {
    const modal = document.getElementById('ticketHubComplianceFiltersModal');
    if (!modal) return;
    modal.classList.remove('ticket-hub-detail-modal-open');
    modal.setAttribute('aria-hidden', 'true');
    const openBtn = document.getElementById('ticketHubComplianceFiltersOpenBtn');
    if (openBtn) openBtn.setAttribute('aria-expanded', 'false');
}

function wireComplianceHubFiltersModal() {
    const openBtn = document.getElementById('ticketHubComplianceFiltersOpenBtn');
    const modal = document.getElementById('ticketHubComplianceFiltersModal');
    if (!modal || modal.dataset.complianceHubFiltersInit === '1') return;
    modal.dataset.complianceHubFiltersInit = '1';

    if (openBtn) {
        openBtn.addEventListener('click', (e) => {
            e.preventDefault();
            openTicketHubComplianceFiltersModal();
        });
    }

    const backdrop = modal.querySelector('.ticket-hub-detail-modal-backdrop');
    if (backdrop) {
        backdrop.addEventListener('click', () => {
            closeTicketHubComplianceFiltersModal();
        });
    }
    const closeBtn = document.getElementById('ticketHubComplianceFiltersCloseBtn');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            closeTicketHubComplianceFiltersModal();
        });
    }
    const resetBtn = document.getElementById('ticketHubComplianceFiltersResetBtn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            resetComplianceHubFilters();
            void reloadComplianceHubProjectsFromFilters();
        });
    }

    const fromEl = document.getElementById('ticketHubComplianceFilterFrom');
    const toEl = document.getElementById('ticketHubComplianceFilterTo');
    const useDateEl = document.getElementById('ticketHubComplianceUseDateRange');

    function applyRangeFromInputs() {
        const from = fromEl && fromEl.value ? String(fromEl.value).trim() : '';
        const to = toEl && toEl.value ? String(toEl.value).trim() : '';
        if (!from || !to) return;
        complianceHubDateRange = { from, to };
        void reloadComplianceHubProjectsFromFilters();
    }

    if (fromEl) fromEl.addEventListener('change', applyRangeFromInputs);
    if (toEl) toEl.addEventListener('change', applyRangeFromInputs);

    if (useDateEl) {
        useDateEl.addEventListener('change', () => {
            complianceHubUseDateRange = !!useDateEl.checked;
            if (complianceHubUseDateRange && !complianceHubDateRange) {
                complianceHubDateRange = defaultComplianceHubDateRange();
            }
            syncComplianceHubFiltersUi();
            void reloadComplianceHubProjectsFromFilters();
        });
    }

    document.querySelectorAll('input[name="ticketHubComplianceListMode"]').forEach((radio) => {
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            complianceHubListMode =
                radio.value === 'closed' ? 'closed' : 'open';
            if (complianceHubListMode === 'closed') {
                complianceHubUseDateRange = true;
                if (!complianceHubDateRange) {
                    complianceHubDateRange = defaultComplianceHubDateRange();
                }
            }
            if (complianceHubListMode === 'open' && selectedComplianceHubJobKey) {
                const listProject = findComplianceHubProject(selectedComplianceHubJobKey);
                if (!listProject || complianceHubProjectIsClosed(listProject)) {
                    selectedComplianceHubJobKey = null;
                    complianceHubProjectDetail = null;
                    renderComplianceHubDetailEmpty();
                }
            }
            syncComplianceHubFiltersUi();
            void reloadComplianceHubProjectsFromFilters();
        });
    });

    document.querySelectorAll('[data-compliance-date-preset]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const daysRaw = btn.getAttribute('data-compliance-date-preset');
            const days =
                daysRaw != null ? parseInt(String(daysRaw), 10) : COMPLIANCE_HUB_DATE_PRESET_DAYS;
            const span =
                Number.isFinite(days) && days > 0 ? days : COMPLIANCE_HUB_DATE_PRESET_DAYS;
            const today = new Date();
            const start = new Date(today);
            start.setDate(start.getDate() - (span - 1));
            complianceHubDateRange = {
                from: formatComplianceHubDateIsoLocal(start),
                to: formatComplianceHubDateIsoLocal(today),
            };
            complianceHubUseDateRange = true;
            if (complianceHubListMode === 'open' && useDateEl) {
                useDateEl.checked = true;
            }
            syncComplianceHubFiltersUi();
            void reloadComplianceHubProjectsFromFilters();
        });
    });

    syncComplianceHubFiltersUi();
}

function wireComplianceHubSearch() {
    const input = document.getElementById('ticketHubComplianceSearch');
    if (!input || input.dataset.complianceHubSearchInit === '1') return;
    input.dataset.complianceHubSearchInit = '1';
    input.addEventListener('input', () => {
        complianceHubSearchQuery = input.value != null ? String(input.value) : '';
        complianceHubClientPage = 1;
        renderComplianceHubJobsTable();
    });
}

function wireComplianceHubProjectsPager() {
    const prevBtn = document.getElementById('ticketHubCompliancePrev');
    const nextBtn = document.getElementById('ticketHubComplianceNext');
    if (prevBtn && prevBtn.dataset.complianceHubPagerInit !== '1') {
        prevBtn.dataset.complianceHubPagerInit = '1';
        prevBtn.addEventListener('click', () => {
            if (complianceHubClientPage <= 1) return;
            complianceHubClientPage -= 1;
            renderComplianceHubJobsTable();
            scrollComplianceHubJobsToTop();
        });
    }
    if (nextBtn && nextBtn.dataset.complianceHubPagerInit !== '1') {
        nextBtn.dataset.complianceHubPagerInit = '1';
        nextBtn.addEventListener('click', () => {
            const filtered = getFilteredComplianceHubProjects();
            const totalPages = Math.max(1, Math.ceil(filtered.length / COMPLIANCE_HUB_PAGE_SIZE));
            if (complianceHubClientPage >= totalPages) return;
            complianceHubClientPage += 1;
            renderComplianceHubJobsTable();
            scrollComplianceHubJobsToTop();
        });
    }
}

function wireComplianceHubCreateProject() {
    const btn = document.getElementById('ticketHubCreateProjectBtn');
    if (!btn || btn.dataset.complianceHubCreateInit === '1') return;
    btn.dataset.complianceHubCreateInit = '1';
    btn.addEventListener('click', () => {
        void createComplianceHubProject();
    });
}

function openTicketHubCreateMenuModal() {
    const modal = document.getElementById('ticketHubCreateMenuModal');
    if (!modal) return;
    modal.classList.add('ticket-hub-detail-modal-open');
    modal.setAttribute('aria-hidden', 'false');
}

function closeTicketHubCreateMenuModal() {
    const modal = document.getElementById('ticketHubCreateMenuModal');
    if (!modal) return;
    modal.classList.remove('ticket-hub-detail-modal-open');
    modal.setAttribute('aria-hidden', 'true');
}

function wireTicketHubCreateActions() {
    const createTicketBtn = document.getElementById('ticketHubCreateTicketBtn');
    if (createTicketBtn && createTicketBtn.dataset.ticketHubCreateTicketInit !== '1') {
        createTicketBtn.dataset.ticketHubCreateTicketInit = '1';
        createTicketBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (typeof openCreateTicketWizard === 'function') {
                openCreateTicketWizard();
            }
        });
    }
    wireComplianceHubCreateProject();
    const menuModal = document.getElementById('ticketHubCreateMenuModal');
    if (!menuModal || menuModal.dataset.ticketHubCreateMenuInit === '1') return;
    menuModal.dataset.ticketHubCreateMenuInit = '1';
    const backdrop = menuModal.querySelector('.ticket-hub-detail-modal-backdrop');
    if (backdrop) {
        backdrop.addEventListener('click', () => {
            closeTicketHubCreateMenuModal();
        });
    }
    menuModal.querySelectorAll('[data-ticket-hub-create-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const action = btn.getAttribute('data-ticket-hub-create-action');
            closeTicketHubCreateMenuModal();
            if (action === 'ticket') {
                if (typeof openCreateTicketWizard === 'function') {
                    openCreateTicketWizard();
                }
                return;
            }
            if (action === 'project') {
                void createComplianceHubProject();
            }
        });
    });
}

function wireTicketHubSectionTabs() {
    if (complianceHubSectionTabsWired) return;
    const tablist = document.querySelector('#ticketHubWindow .ticket-hub-section-tablist');
    if (!tablist) return;
    complianceHubSectionTabsWired = true;
    tablist.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-ticket-hub-section]');
        if (!btn || !tablist.contains(btn)) return;
        setTicketHubActiveSection(btn.getAttribute('data-ticket-hub-section'));
    });
}

function applyTicketHubSectionVisibility(sectionId) {
    const ticketsSection = document.getElementById('ticketHubTicketsSection');
    const complianceSection = document.getElementById('ticketHubComplianceSection');
    const analyticsSection = document.getElementById('ticketHubAnalyticsSection');
    const bulkBar = document.getElementById('ticketHubBulkBar');
    const active = 'tickets';
    if (ticketsSection) {
        ticketsSection.classList.add('ticket-hub-section--active');
        ticketsSection.removeAttribute('hidden');
    }
    if (complianceSection) {
        complianceSection.classList.remove('ticket-hub-section--active');
        complianceSection.setAttribute('hidden', '');
    }
    if (analyticsSection) {
        analyticsSection.classList.remove('ticket-hub-section--active');
        analyticsSection.setAttribute('hidden', '');
    }
    if (bulkBar) {
        bulkBar.hidden = false;
    }
    void sectionId;
    void active;
}

async function renderTicketHubComplianceSection() {
    wireComplianceHubJobsTable();
    wireComplianceHubSearch();
    wireComplianceHubProjectsPager();
    wireComplianceHubFiltersModal();
    syncComplianceHubFiltersUi();
    await loadComplianceHubProjects();
    if (selectedComplianceHubJobKey && !findComplianceHubProject(selectedComplianceHubJobKey)) {
        const stillExists = complianceHubProjects.some(
            (p) => p.jobNameKey === selectedComplianceHubJobKey
        );
        if (!stillExists) {
            selectedComplianceHubJobKey = null;
            complianceHubProjectDetail = null;
            renderComplianceHubDetailEmpty();
            renderComplianceHubJobsTable();
            return;
        }
    }
    if (selectedComplianceHubJobKey) {
        ensureComplianceHubPageContainsJob(selectedComplianceHubJobKey);
    }
    renderComplianceHubJobsTable();
    if (selectedComplianceHubJobKey) {
        await renderComplianceHubProjectDetail(selectedComplianceHubJobKey);
    }
}

function setTicketHubActiveSection(sectionId) {
    const next = 'tickets';
    hideTicketHubProjectDetailModal();
    if (ticketHubActiveSection === next) {
        applyTicketHubSectionVisibility(next);
        return;
    }
    ticketHubActiveSection = next;
    applyTicketHubSectionVisibility(next);
    if (typeof window.renderHubTable === 'function') {
        window.renderHubTable();
    }
    void sectionId;
}

function resetTicketHubSectionOnOpen() {
    const defaultSection = 'tickets';
    ticketHubActiveSection = defaultSection;
    selectedComplianceHubJobKey = null;
    complianceHubSearchQuery = '';
    complianceHubProjects = [];
    complianceHubProjectDetail = null;
    complianceHubListMode = 'open';
    complianceHubUseDateRange = false;
    complianceHubDateRange = null;
    complianceHubClientPage = 1;
    hideTicketHubProjectDetailModal();
    closeTicketHubCreateMenuModal();
    closeTicketHubComplianceFiltersModal();
    const searchInput = document.getElementById('ticketHubComplianceSearch');
    if (searchInput) searchInput.value = '';
    resetComplianceHubFilters();
    applyTicketHubSectionVisibility(defaultSection);
    renderComplianceHubDetailEmpty();
}

function initTicketHubSections() {
    wireTicketHubSectionTabs();
    wireTicketHubCreateActions();
    wireComplianceHubProjectStatusDelegation();
    if (typeof window.syncTicketHubAnalyticsTabVisibility === 'function') {
        window.syncTicketHubAnalyticsTabVisibility();
    }
    applyTicketHubSectionVisibility(ticketHubActiveSection);
}

function redrawTicketHubComplianceIfOpen() {
    const win = document.getElementById('ticketHubWindow');
    if (!win || !win.classList.contains('show')) return;
    if (ticketHubActiveSection !== 'compliance') return;
    void renderTicketHubComplianceSection();
}

async function refreshComplianceHubStatusForTicket(ticket) {
    const jobName =
        typeof window.pickJobNameForCompliance === 'function'
            ? window.pickJobNameForCompliance(ticket)
            : null;
    if (!jobName) return;
    const key = jobName.trim().toLowerCase();
    await loadComplianceHubProjects();
    if (selectedComplianceHubJobKey === key) {
        await renderComplianceHubProjectDetail(key);
    } else {
        renderComplianceHubJobsTable();
    }
}

async function openTicketHubToProject(jobNameKey) {
    const key = jobNameKey != null ? String(jobNameKey).trim().toLowerCase() : '';
    if (!key) return false;
    if (typeof window.openTicketHubWindow === 'function') {
        await window.openTicketHubWindow({ skipPacPoll: true, skipServerTicketLoad: true });
    }
    if (typeof window.setTicketHubActiveSection === 'function') {
        window.setTicketHubActiveSection('tickets');
    }
    return true;
}

window.openTicketHubToProject = openTicketHubToProject;
window.complianceHubApiBase = complianceHubApiBase;
window.renderComplianceHubProjectDetail = renderComplianceHubProjectDetail;
window.loadComplianceHubProjects = loadComplianceHubProjects;

window.initTicketHubSections = initTicketHubSections;
window.resetTicketHubSectionOnOpen = resetTicketHubSectionOnOpen;
window.setTicketHubActiveSection = setTicketHubActiveSection;
window.renderTicketHubComplianceSection = renderTicketHubComplianceSection;
window.refreshComplianceHubStatusForTicket = refreshComplianceHubStatusForTicket;
window.refreshComplianceHubProjectStatus = refreshComplianceHubProjectStatus;
window.redrawTicketHubComplianceIfOpen = redrawTicketHubComplianceIfOpen;
window.getTicketHubActiveSection = function getTicketHubActiveSection() {
    return ticketHubActiveSection;
};
window.closeTicketHubProjectDetailModal = closeTicketHubProjectDetailModal;
window.toggleTicketHubProjectDetailMobileHeight = toggleTicketHubProjectDetailMobileHeight;
window.closeTicketHubCreateMenuModal = closeTicketHubCreateMenuModal;
window.openTicketHubComplianceFiltersModal = openTicketHubComplianceFiltersModal;
window.closeTicketHubComplianceFiltersModal = closeTicketHubComplianceFiltersModal;

(function initTicketHubComplianceModals() {
    const projectModal = document.getElementById('ticketHubProjectDetailModal');
    if (projectModal && projectModal.dataset.complianceHubProjectModalInit !== '1') {
        projectModal.dataset.complianceHubProjectModalInit = '1';
        const backdrop = projectModal.querySelector('.ticket-hub-detail-modal-backdrop');
        if (backdrop) {
            backdrop.addEventListener('click', () => {
                closeTicketHubProjectDetailModal();
            });
        }
        const heightGrab = document.getElementById('ticketHubProjectDetailMobileHeightGrab');
        if (heightGrab) {
            heightGrab.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleTicketHubProjectDetailMobileHeight();
            });
        }
    }
    if (!window.__ticketHubComplianceFiltersEscapeInit) {
        window.__ticketHubComplianceFiltersEscapeInit = true;
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const modal = document.getElementById('ticketHubComplianceFiltersModal');
            if (!modal || !modal.classList.contains('ticket-hub-detail-modal-open')) return;
            closeTicketHubComplianceFiltersModal();
        });
    }
})();
