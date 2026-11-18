// Data layers table renderer (with optional user groups)
function renderDataLayersTable(tbody, emptyState) {
    const savedLayers = window.annotationStorageModule?.savedDataLayers || [];
    const view = 'layers';
    const searchTerm = window.tableFilteringModule?.getSearchTerm() || '';
    let filteredLayers = window.tableFilteringModule?.filterDataLayers(savedLayers, searchTerm) || savedLayers;
    if (window.dataHubFiltersModule?.applyFilters) {
        filteredLayers = window.dataHubFiltersModule.applyFilters(view, filteredLayers);
    }
    const sortState = window.tableSortingModule?.getSortStateForView
        ? window.tableSortingModule.getSortStateForView(view)
        : window.tableSortingModule?.getSortState() || { column: null, direction: 'asc' };
    const sortedLayers = sortState.column
        ? window.tableSortingModule.sortData(filteredLayers, sortState.column, sortState.direction, view)
        : filteredLayers;
    const selectedDataIds = window.dataSelectionModule?.selectedDataIds || new Set();
    const utils = window.tableUtilsModule || {};
    const setEmpty = utils.setDataTableEmptyMessage || ((el, msg) => { el.textContent = msg; });

    if (sortedLayers.length === 0) {
        tbody.innerHTML = '';
        if (window.dataHubPaginationModule?.clearDataHubPagination) {
            window.dataHubPaginationModule.clearDataHubPagination();
        }
        if (emptyState) {
            emptyState.style.display = 'block';
            setEmpty(
                emptyState,
                'No saved data layers found. Save your annotations as a data layer or upload data to see them here!'
            );
        }
        return;
    }
    if (emptyState) emptyState.style.display = 'none';

    const groupsModule = window.dataWindowGroupsModule;
    const T = window.tableActionHtml;

    const groups = groupsModule ? groupsModule.getGroups(view) : [];
    const groupToItems = new Map();
    groups.forEach(g => groupToItems.set(g.id, []));
    const ungrouped = [];
    sortedLayers.forEach(layer => {
        const group = groupsModule && groupsModule.getGroupByItemId(view, layer.id);
        if (group && groupToItems.has(group.id)) {
            groupToItems.get(group.id).push(layer);
        } else {
            ungrouped.push(layer);
        }
    });

    const various = window.utilityTypesModule?.DATA_LAYER_UTILITY_VARIOUS || 'Various';

    function canShowLayerPublicToggle(layer) {
        if (!window.annotationStorageModule?.canAdminLayerPublicFlag?.()) return false;
        if (layer.shared) return false;
        if (typeof window.isCurrentOrgPublicCatalogViewer === 'function' && window.isCurrentOrgPublicCatalogViewer()) {
            return false;
        }
        return true;
    }

    function buildLayerInfoFields(layer, createdDate, annotationCount) {
        const fields = [
            { label: 'Name', value: layer.name || 'Unnamed Layer' },
            { label: 'Type', value: 'Data layer' },
            { label: 'Utility', value: layer.utilityType || 'Other' },
            { label: 'Items', value: `${annotationCount} item${annotationCount !== 1 ? 's' : ''}` },
            { label: 'Created', value: createdDate },
        ];
        if (canShowLayerPublicToggle(layer)) {
            fields.push({
                label: 'Public sharing',
                publicToggleLayerId: String(layer.id),
                publicChecked: !!layer.isPublic,
            });
        }
        return fields;
    }

    function rowForLayer(layer, nameIndent) {
        const idAttr = escapeHtmlAttr(layer.id);
        const isSelected = selectedDataIds.has(layer.id);
        const createdDate = escapeHtmlText(window.formatRecordedDateTime(layer.createdAt));
        const annotationCount = layer.annotations ? layer.annotations.length : 0;
        const indent = nameIndent ? ' style="padding-left: 1.5rem;"' : '';
        const isVarious = (layer.utilityType || '') === various;
        const displayName = escapeHtmlText(layer.name || 'Unnamed Layer');
        const typeCell = isVarious
            ? `<span style="color: var(--app-text-primary); font-size: 0.875rem;" title="This layer contains more than one utility type; change types by editing individual features after loading.">${escapeHtmlText(various)}</span>`
            : `<select data-action="update-layer-utility" data-id="${idAttr}" style="background: var(--app-bg-surface); color: var(--app-text-inverse); border: 1px solid #404040; padding: 2px 4px; border-radius: 4px; font-size: 0.875rem;">
                        ${utils.getUtilityTypeOptions ? utils.getUtilityTypeOptions(layer.utilityType || 'Other') : ''}
                    </select>`;
        const rawCreatedDate = window.formatRecordedDateTime(layer.createdAt);
        const infoBtn = window.manageDataRowInfoButton
            ? window.manageDataRowInfoButton(
                'Data layer',
                buildLayerInfoFields(layer, rawCreatedDate, annotationCount),
                { alwaysVisible: true }
            )
            : '';
        return `
            <tr class="data-row ${nameIndent ? 'data-group-child' : ''} ${isSelected ? 'selected' : ''}" data-id="${idAttr}" data-type="layer">
                <td class="data-table-checkbox">
                    ${T.checkbox('toggle-selection', { id: layer.id }, isSelected)}
                </td>
                <td class="data-table-thumb"><div class="data-table-thumb-inner"><span class="data-table-thumb-emoji" aria-hidden="true">🗂️</span></div></td>
                <td class="data-table-name"${indent}>
                    <span class="data-table-name-with-flags">
                        ${T.editableName(layer.id, 'layer', displayName)}${T.publicIndicator ? T.publicIndicator(layer.isPublic) : ''}
                    </span>
                </td>
                <td class="data-table-type">
                    ${typeCell}
                </td>
                <td class="data-table-color">
                    <span style="color: var(--app-text-secondary);">${annotationCount} items</span>
                </td>
                <td class="data-table-actions">
                    ${T.btn('load-layer', { id: layer.id }, 'Load', { title: 'Load' })}
                    ${infoBtn}
                    ${T.deleteBtn('delete-layer', { id: layer.id }, 'Delete')}
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
        ? pag.buildUserGroupAndDayGroupings(groups, groupToItems, ungrouped, (layer) => layer.createdAt, view)
        : [];
    const slice = pag ? pag.paginateDataHubGroupings(view, groupings) : { pageGroupings: groupings };
    slice.pageGroupings.forEach((entry) => {
        if (entry.type === 'userGroup') {
            const group = entry.group;
            const items = entry.items || [];
        const gAttr = escapeHtmlAttr(group.id);
        const isGroupSelected = items.length > 0 && items.every(l => selectedDataIds.has(l.id));
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
                    ${T.groupActions(view, group.id)}
                </td>
            </tr>
        `;
        if (!collapsed) items.forEach(layer => { html += rowForLayer(layer, true); });
            return;
        }
        if (entry.type === 'day') {
            const bucket = entry.bucket;
        if (utils.renderDataTableDateSectionRow) {
            html += utils.renderDataTableDateSectionRow(bucket.label, bucket.items.length, 'item');
        }
        bucket.items.forEach(layer => { html += rowForLayer(layer, false); });
        }
    });
    tbody.innerHTML = html;
    if (pag) pag.renderDataHubPagination(view, slice);
}

// Export
window.layersTableRenderer = {
    renderDataLayersTable
};
