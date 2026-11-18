// Documents table renderer (with optional user groups)
function renderDocumentsTable(tbody, emptyState) {
    let documents = window.documentsModule?.savedDocuments || [];
    const selectedDataIds = window.dataSelectionModule?.selectedDataIds || new Set();
    if (window.documentQueryResults && window.documentQueryResults.length > 0) {
        const queryResultIds = new Set(window.documentQueryResults);
        documents = documents.filter(doc => queryResultIds.has(doc.id));
    }
    const view = 'documents';
    const searchTerm = window.tableFilteringModule?.getSearchTerm() || '';
    let filteredDocuments = window.tableFilteringModule?.filterDocuments(documents, searchTerm) || documents;
    if (window.dataHubFiltersModule?.applyFilters) {
        filteredDocuments = window.dataHubFiltersModule.applyFilters(view, filteredDocuments);
    }
    const sortState = window.tableSortingModule?.getSortStateForView
        ? window.tableSortingModule.getSortStateForView(view)
        : window.tableSortingModule?.getSortState() || { column: null, direction: 'asc' };
    const sortedDocuments = sortState.column
        ? window.tableSortingModule.sortData(filteredDocuments, sortState.column, sortState.direction, view)
        : filteredDocuments;
    const utils = window.tableUtilsModule || {};
    const setEmpty = utils.setDataTableEmptyMessage || ((el, msg) => { el.textContent = msg; });
    const groupsModule = window.dataWindowGroupsModule;

    if (sortedDocuments.length === 0) {
        tbody.innerHTML = '';
        if (window.dataHubPaginationModule?.clearDataHubPagination) {
            window.dataHubPaginationModule.clearDataHubPagination();
        }
        if (emptyState) {
            emptyState.style.display = 'block';
            setEmpty(
                emptyState,
                documents.length === 0 ? 'No documents uploaded yet.' : 'No documents match your search or filter.'
            );
        }
        return;
    }
    if (emptyState) emptyState.style.display = 'none';

    const T = window.tableActionHtml;
    const groups = groupsModule ? groupsModule.getGroups(view) : [];
    const groupToItems = new Map();
    groups.forEach(g => groupToItems.set(g.id, []));
    const ungrouped = [];
    sortedDocuments.forEach(doc => {
        const group = groupsModule && groupsModule.getGroupByItemId(view, doc.id);
        if (group && groupToItems.has(group.id)) {
            groupToItems.get(group.id).push(doc);
        } else {
            ungrouped.push(doc);
        }
    });

    function rowForDoc(doc, nameIndent) {
        const idAttr = escapeHtmlAttr(doc.id);
        const isSelected = selectedDataIds.has(doc.id);
        const createdDate = escapeHtmlText(window.formatRecordedDateTime(doc.createdAt));
        const fileSize = escapeHtmlText(doc.fileSize ? utils.formatFileSize(doc.fileSize) : '—');
        const indent = nameIndent ? ' style="padding-left: 1.5rem;"' : '';
        const locButton = doc.geometry
            ? T.btn('remove-document-location', { id: doc.id }, 'Remove Location', { title: 'Remove Location', style: 'background: var(--app-danger);' })
            : T.btn('set-document-location', { id: doc.id }, 'Set Location', { title: 'Set Location', style: 'background: var(--app-success);' });
        const typeLine = escapeHtmlText(`PDF${doc.geometry ? ` (${doc.geometry.type})` : ''}`);
        const displayName = escapeHtmlText(doc.fileName || 'Unnamed Document');
        const infoBtn = window.manageDataRowInfoButton
            ? window.manageDataRowInfoButton('Document', [
                { label: 'Type', value: typeLine },
                { label: 'Size', value: fileSize },
                { label: 'Created', value: createdDate },
                { label: 'Location', value: doc.geometry ? 'On map' : 'Not set' },
            ])
            : '';
        return `
            <tr class="data-row ${nameIndent ? 'data-group-child' : ''} ${isSelected ? 'selected' : ''}" data-id="${idAttr}" data-type="document">
                <td class="data-table-checkbox">
                    ${T.checkbox('toggle-selection', { id: doc.id }, isSelected)}
                </td>
                <td class="data-table-thumb"><div class="data-table-thumb-inner"><span class="data-table-thumb-emoji" aria-hidden="true">📄</span></div></td>
                <td class="data-table-name"${indent}>
                    ${T.editableName(doc.id, 'document', displayName)}
                </td>
                <td class="data-table-type">${typeLine}</td>
                <td class="data-table-color">${fileSize}</td>
                <td class="data-table-actions">
                    ${infoBtn}
                    ${T.btn('view-document', { id: doc.id }, 'View', { title: 'View' })}
                    ${locButton}
                    ${T.deleteBtn('delete-document', { id: doc.id }, 'Delete')}
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
        ? pag.buildUserGroupAndDayGroupings(groups, groupToItems, ungrouped, (doc) => doc.createdAt, view)
        : [];
    const slice = pag ? pag.paginateDataHubGroupings(view, groupings) : { pageGroupings: groupings };
    slice.pageGroupings.forEach((entry) => {
        if (entry.type === 'userGroup') {
            const group = entry.group;
            const items = entry.items || [];
        const gAttr = escapeHtmlAttr(group.id);
        const isGroupSelected = items.length > 0 && items.every(d => selectedDataIds.has(d.id));
        const collapsed = !!group.collapsed;
        const gInfo = window.manageDataRowInfoButton
            ? window.manageDataRowInfoButton('Group', [
                { label: 'Type', value: 'Group' },
                { label: 'Items', value: String(items.length) },
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
                    <span style="color: var(--app-text-secondary); font-weight: normal; font-size: 0.875rem;">(${items.length} item${items.length !== 1 ? 's' : ''})</span>
                </td>
                <td class="data-table-type" aria-hidden="true"></td>
                <td class="data-table-color" aria-hidden="true"></td>
                <td class="data-table-actions">
                    ${gInfo}
                    ${T.groupActions(view, group.id, 'Delete this group? Documents will not be deleted.')}
                </td>
            </tr>
        `;
        if (!collapsed) items.forEach(doc => { html += rowForDoc(doc, true); });
            return;
        }
        if (entry.type === 'day') {
            const bucket = entry.bucket;
        if (utils.renderDataTableDateSectionRow) {
            html += utils.renderDataTableDateSectionRow(bucket.label, bucket.items.length, 'item');
        }
        bucket.items.forEach(doc => { html += rowForDoc(doc, false); });
        }
    });
    tbody.innerHTML = html;
    if (pag) pag.renderDataHubPagination(view, slice);
}

// Export
window.documentsTableRenderer = {
    renderDocumentsTable
};
