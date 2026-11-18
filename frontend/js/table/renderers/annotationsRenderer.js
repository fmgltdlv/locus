// Annotations table renderer (with optional user groups)
function renderAnnotationsTable(tbody, emptyState) {
    const annotations = window.annotationStorageModule?.annotations || [];
    const view = 'annotations';
    const searchTerm = window.tableFilteringModule?.getSearchTerm() || '';
    let filteredAnnotations =
        window.tableFilteringModule?.filterAnnotations(annotations, searchTerm) || annotations;
    if (window.dataHubFiltersModule?.applyFilters) {
        filteredAnnotations = window.dataHubFiltersModule.applyFilters(view, filteredAnnotations);
    }
    const sortState = window.tableSortingModule?.getSortStateForView
        ? window.tableSortingModule.getSortStateForView(view)
        : window.tableSortingModule?.getSortState() || { column: null, direction: 'asc' };
    const sortedAnnotations = sortState.column
        ? window.tableSortingModule.sortData(filteredAnnotations, sortState.column, sortState.direction, view)
        : filteredAnnotations;
    const selectedDataIds = window.dataSelectionModule?.selectedDataIds || new Set();
    const layerModule = window.layerManagerModule;
    const annotationsCleared = layerModule?.annotationsLayerCleared || false;
    const hasAnnotations = annotations.length > 0;
    const groupsModule = window.dataWindowGroupsModule;
    const T = window.tableActionHtml;

    const utils = window.tableUtilsModule || {};
    const setEmpty = utils.setDataTableEmptyMessage || ((el, msg) => { el.textContent = msg; });

    if (sortedAnnotations.length === 0 && !annotationsCleared) {
        tbody.innerHTML = '';
        if (window.dataHubPaginationModule?.clearDataHubPagination) {
            window.dataHubPaginationModule.clearDataHubPagination();
        }
        if (emptyState) {
            emptyState.style.display = 'block';
            setEmpty(emptyState, 'No annotations found. Create some annotations on the map!');
        }
        return;
    }

    if (annotationsCleared && hasAnnotations) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align: center; padding: 2rem;">
                    <div style="display: flex; flex-direction: column; align-items: center; gap: 1rem;">
                        <p style="color: var(--app-text-secondary); margin: 0;">Annotations have been cleared from the map.</p>
                        ${T.btn('restore-annotations', {}, 'Restore All Annotations', { style: 'background: var(--app-accent); color: var(--app-button-primary-text, var(--app-text-inverse)); padding: 0.5rem 1rem; border: none; border-radius: 0.25rem; cursor: pointer;' })}
                    </div>
                </td>
            </tr>
        `;
        if (window.dataHubPaginationModule?.clearDataHubPagination) {
            window.dataHubPaginationModule.clearDataHubPagination();
        }
        if (emptyState) emptyState.style.display = 'none';
        return;
    }

    if (emptyState) emptyState.style.display = 'none';

    // Partition into group buckets and ungrouped
    const groupToItems = new Map();
    const ungrouped = [];
    const groups = groupsModule ? groupsModule.getGroups(view) : [];
    groups.forEach(g => groupToItems.set(g.id, []));
    sortedAnnotations.forEach(annotation => {
        const group = groupsModule && groupsModule.getGroupByItemId(view, annotation.id);
        if (group && groupToItems.has(group.id)) {
            groupToItems.get(group.id).push(annotation);
        } else {
            ungrouped.push(annotation);
        }
    });

    const annotationThumbCell = '<td class="data-table-thumb" aria-hidden="true"></td>';

    function rowForAnnotation(annotation, extraClass, nameIndent) {
        const idAttr = escapeHtmlAttr(annotation.id);
        const isSelected = selectedDataIds.has(annotation.id);
        const createdDate = escapeHtmlText(window.formatRecordedDateTime(annotation.createdAt));
        const indent = nameIndent ? ' style="padding-left: 1.5rem;"' : '';
        const utilHtml =
            utils.getUtilityTypeDisplay && (annotation.color || annotation.utilityType)
                ? utils.getUtilityTypeDisplay(annotation.color, annotation.utilityType)
                : escapeHtmlText(annotation.color || annotation.utilityType || '—');
        const displayName = escapeHtmlText(annotation.name || annotation.type || 'Unnamed');
        const typeCell = escapeHtmlText(annotation.type || '—');
        const utilInfoLabel = escapeHtmlText(annotation.utilityType || '—');
        const infoBtn = window.manageDataRowInfoButton
            ? window.manageDataRowInfoButton('Annotation', [
                { label: 'Type', value: annotation.type || '—' },
                { label: 'Utility', value: utilInfoLabel },
                { label: 'Created', value: createdDate },
            ])
            : '';
        return `
            <tr class="data-row ${extraClass || ''} ${isSelected ? 'selected' : ''}" data-id="${idAttr}">
                <td class="data-table-checkbox">
                    ${T.checkbox('toggle-selection', { id: annotation.id }, isSelected)}
                </td>
                ${annotationThumbCell}
                <td class="data-table-name"${indent}>
                    ${T.editableName(annotation.id, 'annotation', displayName)}
                </td>
                <td class="data-table-type">${typeCell}</td>
                <td class="data-table-color">${utilHtml}</td>
                <td class="data-table-actions">
                    ${infoBtn}
                    ${T.btn('view-annotation', { id: annotation.id }, 'View', { title: 'View' })}
                    ${T.deleteBtn('delete-annotation', { id: annotation.id }, 'Delete')}
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
        ? pag.buildUserGroupAndDayGroupings(groups, groupToItems, ungrouped, (annotation) => annotation.createdAt, view)
        : [];
    const slice = pag ? pag.paginateDataHubGroupings(view, groupings) : { pageGroupings: groupings };
    slice.pageGroupings.forEach((entry) => {
        if (entry.type === 'userGroup') {
            const group = entry.group;
            const items = entry.items || [];
        const gAttr = escapeHtmlAttr(group.id);
        const isGroupSelected = items.length > 0 && items.every(a => selectedDataIds.has(a.id));
        const collapsed = !!group.collapsed;
        const gInfo = window.manageDataRowInfoButton
            ? window.manageDataRowInfoButton('Group', [
                { label: 'Type', value: 'Group' },
                { label: 'Items in group', value: String(items.length) },
            ])
            : '';
        html += `
            <tr class="data-group-row photo-batch-header ${isGroupSelected ? 'selected' : ''}" data-group-id="${gAttr}" data-view="${escapeHtmlAttr(view)}" style="background: var(--app-bg-surface); font-weight: 600;">
                <td class="data-table-checkbox">
                    ${T.checkbox('toggle-group-selection', { view, groupId: group.id }, isGroupSelected)}
                </td>
                ${annotationThumbCell}
                <td class="data-table-name">
                    ${T.groupToggle(view, group.id, collapsed)}
                    <span class="data-group-name">${escapeHtmlText(group.name || 'Group')}</span>
                    <span style="color: var(--app-text-secondary); font-weight: normal; font-size: 0.875rem;">(${items.length} item${items.length !== 1 ? 's' : ''})</span>
                </td>
                <td class="data-table-type" aria-hidden="true"></td>
                <td class="data-table-color" aria-hidden="true"></td>
                <td class="data-table-actions">
                    ${gInfo}
                    ${T.groupActions(view, group.id, 'Delete this group? Items will not be deleted.')}
                </td>
            </tr>
        `;
        if (!collapsed) {
            items.forEach(annotation => {
                html += rowForAnnotation(annotation, 'data-group-child', true);
            });
        }
            return;
        }
        if (entry.type === 'day') {
            const bucket = entry.bucket;
        if (utils.renderDataTableDateSectionRow) {
            html += utils.renderDataTableDateSectionRow(bucket.label, bucket.items.length, 'item');
        }
        bucket.items.forEach(annotation => {
            html += rowForAnnotation(annotation, '', false);
        });
        }
    });

    tbody.innerHTML = html;
    if (pag) pag.renderDataHubPagination(view, slice);
}

// Export
window.annotationsTableRenderer = {
    renderAnnotationsTable
};

