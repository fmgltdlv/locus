function dataTableLocationIconHtml(size) {
    const icons = window.mapIcons;
    const s = size || 16;
    if (icons && typeof icons.location === 'function') {
        return `<span class="photos-gallery-card__icon" aria-hidden="true">${icons.location(s)}</span>`;
    }
    return '📍';
}

// Whether the DIRT event form is considered completed (signature + key details)
function isEventFormCompleted(report) {
    if (!report) return false;
    if (report.isDraft === true) return false;
    const hasSignature = report.technicianSignature === true;
    const hasDetails = !!(report.description || report.utilityType || report.severity);
    return hasSignature && hasDetails;
}

// Reported events table renderer (with optional user groups)
function renderReportedEventsTable(tbody, emptyState) {
    let currentOrgId = null;
    if (window.authModule && window.authModule.isAuthenticated()) {
        const user = window.authModule.getCurrentUser();
        currentOrgId = user.organizationId;
    }
    let reports = [];
    try {
        if (window.reportedEventsStore && typeof window.reportedEventsStore.getReportsForCurrentOrg === 'function') {
            reports = window.reportedEventsStore.getReportsForCurrentOrg();
        }
        if (!reports.length) {
            const allReports = JSON.parse(localStorage.getItem('dirtReports') || '[]');
            reports = allReports.filter((report) => report.organizationId === currentOrgId);
        }
    } catch (error) {
        console.error('Error loading DIRT reports:', error);
    }
    const windowModule = window.dataWindowModule;
    const filterTicketId = windowModule?.filterTicketId;
    const filterTicketNumber = windowModule?.filterTicketNumber;
    if (filterTicketId != null && filterTicketId !== '' || filterTicketNumber != null && filterTicketNumber !== '') {
        reports = reports.filter(report => {
            const idMatch =
                filterTicketId != null &&
                filterTicketId !== '' &&
                report.ticketId != null &&
                String(report.ticketId) === String(filterTicketId);
            const numMatch =
                filterTicketNumber != null &&
                filterTicketNumber !== '' &&
                String(report.ticketNumber ?? '') === String(filterTicketNumber);
            return idMatch || numMatch;
        });
    }
    const view = 'events';
    const searchTerm = window.tableFilteringModule?.getSearchTerm() || '';
    let filteredReports = window.tableFilteringModule?.filterReportedEvents(reports, searchTerm) || reports;
    if (window.dataHubFiltersModule?.applyFilters) {
        filteredReports = window.dataHubFiltersModule.applyFilters(view, filteredReports);
    }
    const sortState = window.tableSortingModule?.getSortStateForView
        ? window.tableSortingModule.getSortStateForView(view)
        : window.tableSortingModule?.getSortState() || { column: null, direction: 'asc' };
    const sortedReports = sortState.column
        ? window.tableSortingModule.sortData(filteredReports, sortState.column, sortState.direction, view)
        : filteredReports;
    const selectedDataIds = window.dataSelectionModule?.selectedDataIds || new Set();
    const groupsModule = window.dataWindowGroupsModule;
    const T = window.tableActionHtml;

    // Assign stable id per report
    const reportsWithId = sortedReports.map((report, index) => ({
        ...report,
        _stableId: report.id || `event-${index}`
    }));

    const utils = window.tableUtilsModule || {};
    const setEmpty = utils.setDataTableEmptyMessage || ((el, msg) => { el.textContent = msg; });

    if (reportsWithId.length === 0) {
        tbody.innerHTML = '';
        if (window.dataHubPaginationModule?.clearDataHubPagination) {
            window.dataHubPaginationModule.clearDataHubPagination();
        }
        if (emptyState) {
            emptyState.style.display = 'block';
            setEmpty(
                emptyState,
                reports.length === 0 ? 'No reported events found.' : 'No events match your search or filter.'
            );
        }
        return;
    }
    if (emptyState) emptyState.style.display = 'none';

    const groups = groupsModule ? groupsModule.getGroups(view) : [];
    const groupToItems = new Map();
    groups.forEach(g => groupToItems.set(g.id, []));
    const ungrouped = [];
    reportsWithId.forEach(report => {
        const id = report._stableId;
        const group = groupsModule && groupsModule.getGroupByItemId(view, id);
        if (group && groupToItems.has(group.id)) {
            groupToItems.get(group.id).push(report);
        } else {
            ungrouped.push(report);
        }
    });

    function missingTicketBadgeHtml(report, reportId) {
        const mod = window.dirtReportModule;
        if (!mod || typeof mod.getDirtReportTicketLinkStatus !== 'function') return '';
        const status = mod.getDirtReportTicketLinkStatus(report);
        if (status !== 'missing') return '';
        const idAttr = escapeHtmlAttr(reportId);
        return (
            '<button type="button" class="data-missing-ticket-indicator" data-action="explain-missing-ticket" data-id="' +
            idAttr +
            '" title="Why is there no ticket?">No ticket</button>'
        );
    }

    function scheduleEventTicketLinkChecks(reportsWithId, tbody) {
        const mod = window.dirtReportModule;
        if (!mod || typeof mod.resolveDirtReportTicketLink !== 'function' || !tbody) return;
        reportsWithId.forEach(function (report) {
            if (mod.getDirtReportTicketLinkStatus(report) === 'missing') return;
            if (mod.getDirtReportTicketLinkStatus(report) === 'linked') return;
            void mod.resolveDirtReportTicketLink(report).then(function (result) {
                if (!result || result.status !== 'missing') return;
                const row = tbody.querySelector('tr[data-id="' + CSS.escape(String(report._stableId)) + '"]');
                if (!row) return;
                const nameCell = row.querySelector('.data-table-name-with-flags');
                if (!nameCell || nameCell.querySelector('.data-missing-ticket-indicator')) return;
                nameCell.insertAdjacentHTML('beforeend', missingTicketBadgeHtml(report, report._stableId));
            });
        });
    }

    function rowForEvent(report, nameIndent) {
        const reportId = report._stableId;
        const idAttr = escapeHtmlAttr(reportId);
        const isSelected = selectedDataIds.has(reportId);
        const isDraft = report.isDraft === true;
        const completed = isEventFormCompleted(report);
        const statusTitle = isDraft ? 'Draft — reopen to finish' : completed ? 'Form completed' : 'Form incomplete';
        const displayName = escapeHtmlText(report.name || report.ticketNumber || 'Unknown Ticket');
        const indent = nameIndent ? ' style="padding-left: 1.5rem;"' : '';
        const draftFlag = T.draftIndicator ? T.draftIndicator(isDraft) : '';
        const missingTicketBadge = missingTicketBadgeHtml(report, reportId);
        const locButtons =
            report.location && report.location.lat && report.location.lng
                ? T.btn('zoom-to-event', { id: reportId }, dataTableLocationIconHtml(16), {
                      className: 'zoom-pin-button',
                      title: 'Zoom to Location',
                      ariaLabel: 'Zoom to Location',
                  })
                : T.btn('set-event-location', { id: reportId }, 'Set Location', {
                      title: 'Set Location',
                      style: 'background: var(--app-success);',
                  });
        return `
            <tr class="data-row ${nameIndent ? 'data-group-child' : ''} ${isSelected ? 'selected' : ''}" data-id="${idAttr}" data-type="event">
                <td class="data-table-checkbox">
                    ${T.checkbox('toggle-selection', { id: reportId }, isSelected)}
                </td>
                <td class="data-table-thumb"><div class="data-table-thumb-inner" title="${statusTitle}"><span class="data-event-status-dot ${completed ? 'is-complete' : 'is-incomplete'}" aria-hidden="true"></span></div></td>
                <td class="data-table-name"${indent}>
                    <span class="data-table-name-with-flags">
                        ${T.editableName(reportId, 'event', displayName)}${draftFlag}${missingTicketBadge}
                    </span>
                </td>
                <td class="data-table-type" style="display: none;"></td>
                <td class="data-table-color" aria-hidden="true"></td>
                <td class="data-table-actions">
                    ${T.btn('view-event', { id: reportId }, 'View', { title: 'View' })}
                    ${!isDraft ? T.btn('export-event', { id: reportId }, 'Export', { title: 'Export report' }) : ''}
                    ${locButtons}
                    ${T.deleteBtn('delete-event', { id: reportId }, 'Delete')}
                </td>
            </tr>
        `;
    }

    let html = '';
    const pag = window.dataHubPaginationModule;
    if (pag) {
        pag.resetDataHubPageIfSearchChanged(view, searchTerm);
        if (window.dataHubFiltersModule?.getFilterSignature) {
            pag.resetDataHubPageIfFiltersChanged(view, window.dataHubFiltersModule.getFilterSignature(view));
        }
    }
    const groupings = pag
        ? pag.buildUserGroupAndDayGroupings(groups, groupToItems, ungrouped, (report) => report.incidentDate, view)
        : [];
    const slice = pag ? pag.paginateDataHubGroupings(view, groupings) : { pageGroupings: groupings };
    slice.pageGroupings.forEach((entry) => {
        if (entry.type === 'userGroup') {
            const group = entry.group;
            const items = entry.items || [];
        const gAttr = escapeHtmlAttr(group.id);
        const isGroupSelected = items.length > 0 && items.every(r => selectedDataIds.has(r._stableId));
        const collapsed = !!group.collapsed;
        const gInfo = window.manageDataRowInfoButton
            ? window.manageDataRowInfoButton('Group', [
                { label: 'Type', value: 'Group' },
                { label: 'Events', value: String(items.length) },
            ])
            : '';
        html += `
            <tr class="data-group-row photo-batch-header ${isGroupSelected ? 'selected' : ''}" data-group-id="${gAttr}" data-view="${escapeHtmlAttr(view)}" style="background: var(--app-bg-surface); font-weight: 600;">
                <td class="data-table-checkbox">
                    ${T.checkbox('toggle-group-selection', { view, groupId: group.id }, isGroupSelected)}
                </td>
                <td class="data-table-thumb"><div class="data-table-thumb-inner"><span class="data-table-thumb-emoji" aria-hidden="true">📁</span></div></td>
                <td class="data-table-name">
                    ${T.groupToggle(view, group.id, collapsed)}
                    <span class="data-group-name">${escapeHtmlText(group.name || 'Group')}</span>
                    <span style="color: var(--app-text-secondary); font-weight: normal; font-size: 0.875rem;">(${items.length} event${items.length !== 1 ? 's' : ''})</span>
                </td>
                <td class="data-table-type" style="display: none;" aria-hidden="true"></td>
                <td class="data-table-color" aria-hidden="true"></td>
                <td class="data-table-actions">
                    ${gInfo}
                    ${T.groupActions(view, group.id, 'Delete this group? Events will not be deleted.')}
                </td>
            </tr>
        `;
        if (!collapsed) items.forEach(report => { html += rowForEvent(report, true); });
            return;
        }
        if (entry.type === 'day') {
            const bucket = entry.bucket;
        if (utils.renderDataTableDateSectionRow) {
            html += utils.renderDataTableDateSectionRow(bucket.label, bucket.items.length, 'event');
        }
        bucket.items.forEach(report => { html += rowForEvent(report, false); });
        }
    });
    tbody.innerHTML = html;
    scheduleEventTicketLinkChecks(reportsWithId, tbody);
    if (pag) pag.renderDataHubPagination(view, slice);
}

// Export
window.eventsTableRenderer = {
    renderReportedEventsTable,
    isEventFormCompleted
};
