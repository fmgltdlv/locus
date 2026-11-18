// Aerial maps table renderer (accessible catalog in drawn bbox)
function renderAccessibleAerialPagination(slice) {
    const tableContainer = document.querySelector('#dataWindow .data-table-container');
    if (!tableContainer) return;
    if (!slice || slice.totalPages <= 1) {
        if (window.dataHubPaginationModule?.clearDataHubPagination) {
            window.dataHubPaginationModule.clearDataHubPagination();
        }
        return;
    }
    let pager = document.getElementById('dataHubPagination');
    if (!pager) {
        pager = document.createElement('div');
        pager.id = 'dataHubPagination';
        pager.className = 'data-hub-pagination';
        tableContainer.insertAdjacentElement('afterend', pager);
    }
    const T = window.tableActionHtml;
    const rangeStart = slice.total === 0 ? 0 : (slice.page - 1) * slice.pageSize + 1;
    const rangeEnd = slice.total === 0 ? 0 : Math.min(slice.page * slice.pageSize, slice.total);
    pager.innerHTML = `
        <span class="data-hub-pagination-summary">Showing ${rangeStart}–${rangeEnd} of ${slice.total} map${slice.total === 1 ? '' : 's'}</span>
        <span class="data-hub-pagination-controls">
            ${T.btn('aerial-accessible-page', { page: slice.page - 1 }, 'Previous', { disabled: slice.page <= 1 })}
            <span class="data-hub-pagination-page-label">Page ${slice.page} of ${slice.totalPages}</span>
            ${T.btn('aerial-accessible-page', { page: slice.page + 1 }, 'Next', { disabled: slice.page >= slice.totalPages })}
        </span>
    `;
}

function renderAerialMapsTable(tbody, emptyState) {
    const mod = window.aerialMapsModule;
    const maps = mod?.accessibleAerialMaps || [];
    const pagination = mod?.accessibleAerialPagination || { page: 1, total: 0, totalPages: 0, pageSize: 20 };
    const hasBbox = !!mod?.accessibleAerialSearchBbox;
    const tier = mod?.getSubscriptionTierForSelectedOrg ? mod.getSubscriptionTierForSelectedOrg() : 'basic';
    const selectedDataIds = window.dataSelectionModule?.selectedDataIds || new Set();
    const view = 'aerialmaps';
    const searchTerm = window.tableFilteringModule?.getSearchTerm() || '';
    const filteredMaps = searchTerm
        ? maps.filter((map) => (map.name || '').toLowerCase().includes(searchTerm.toLowerCase()))
        : maps;
    const sortState = window.tableSortingModule?.getSortStateForView
        ? window.tableSortingModule.getSortStateForView(view)
        : window.tableSortingModule?.getSortState() || { column: null, direction: 'asc' };
    const sortedMaps = sortState.column
        ? window.tableSortingModule.sortData(filteredMaps, sortState.column, sortState.direction, view)
        : filteredMaps;
    const utils = window.tableUtilsModule || {};
    const groupsModule = window.dataWindowGroupsModule;
    const T = window.tableActionHtml;

    const setEmpty = utils.setDataTableEmptyMessage || ((el, msg) => { el.textContent = msg; });

    if (sortedMaps.length === 0) {
        tbody.innerHTML = '';
        renderAccessibleAerialPagination(pagination.totalPages > 1 ? pagination : null);
        if (emptyState) {
            emptyState.style.display = 'block';
            if (tier === 'basic') {
                setEmpty(emptyState, 'Aerial maps are available on Enhanced organizations.');
            } else if (!hasBbox) {
                setEmpty(
                    emptyState,
                    'Draw a search rectangle on the map (max 5×5 miles) to list orthophotos your organization can access.'
                );
            } else {
                setEmpty(emptyState, 'No aerial maps in this search area match your filters.');
            }
        }
        return;
    }
    if (emptyState) emptyState.style.display = 'none';

    const isManageDataMobile =
        typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches;

    const groups = groupsModule ? groupsModule.getGroups(view) : [];
    const groupToItems = new Map();
    groups.forEach((g) => groupToItems.set(g.id, []));
    const ungrouped = [];
    sortedMaps.forEach((map) => {
        const group = groupsModule && groupsModule.getGroupByItemId(view, map.id);
        if (group && groupToItems.has(group.id)) {
            groupToItems.get(group.id).push(map);
        } else {
            ungrouped.push(map);
        }
    });

    function formatAerialMapBoundingBoxText(map) {
        if (!map.boundingBox || !map.boundingBox.coordinates || !map.boundingBox.coordinates[0]) {
            return 'Not available';
        }
        const ring = map.boundingBox.coordinates[0];
        if (!ring || ring.length < 3) return 'Not available';
        return `Min: [${ring[0][0]}, ${ring[0][1]}]\nMax: [${ring[2][0]}, ${ring[2][1]}]`;
    }

    function rowForMap(map, nameIndent) {
        const idAttr = escapeHtmlAttr(map.id);
        const isSelected = selectedDataIds.has(map.id);
        const cap = map.capturedAt || map.createdAt;
        const createdDate = escapeHtmlText(window.formatRecordedDateTime(cap));
        const indent = nameIndent ? ' style="padding-left: 1.5rem;"' : '';
        const mapNamePlain = String(map.name || 'Unnamed Map');
        const displayName = escapeHtmlText(map.name || 'Unnamed Map');
        const accessLabel =
            map.accessMode === 'restricted'
                ? 'Restricted'
                : map.accessMode === 'hidden'
                  ? 'Hidden'
                  : 'Global';
        const infoFieldsMerged = [
            { label: 'Name', value: mapNamePlain },
            { label: 'Captured', value: createdDate },
            { label: 'Access', value: accessLabel },
            { label: 'Added by', value: map.addedBy ? String(map.addedBy) : 'Unknown' },
            { label: 'Bounding box', value: formatAerialMapBoundingBoxText(map) },
            {
                label: 'On map',
                value: 'Use "Show on map" to fly to this orthophoto extent and load tiles when available.',
            },
        ];
        const infoFieldsDesktop = [
            { label: 'Captured', value: createdDate },
            { label: 'Access', value: accessLabel },
        ];
        const infoBtn = window.manageDataRowInfoButton
            ? window.manageDataRowInfoButton(
                  'Aerial map',
                  isManageDataMobile ? infoFieldsMerged : infoFieldsDesktop
              )
            : '';
        const detailsBtn = isManageDataMobile
            ? ''
            : T.btn('view-aerial-map', { id: map.id }, 'Details', { title: 'Details' });
        return `
            <tr class="data-row ${nameIndent ? 'data-group-child' : ''} ${isSelected ? 'selected' : ''}" data-id="${idAttr}" data-type="aerialmap">
                <td class="data-table-checkbox">
                    ${T.checkbox('toggle-selection', { id: map.id }, isSelected)}
                </td>
                <td class="data-table-thumb"><div class="data-table-thumb-inner"><span class="data-table-thumb-emoji" aria-hidden="true">🗺️</span></div></td>
                <td class="data-table-name"${indent}>
                    ${T.editableName(map.id, 'aerialmap', displayName)}
                </td>
                <td class="data-table-type" style="display: none;" aria-hidden="true"></td>
                <td class="data-table-color" style="display: none;" aria-hidden="true"></td>
                <td class="data-table-actions">
                    ${infoBtn}
                    ${T.btn('fly-to-aerial-map', { id: map.id }, 'Show on map', { title: 'Show extent on map' })}
                    ${detailsBtn}
                </td>
            </tr>
        `;
    }

    let html = '';
    const groupings = groupsModule
        ? window.dataHubPaginationModule?.buildUserGroupAndDayGroupings(
              groups,
              groupToItems,
              ungrouped,
              (map) => map.capturedAt || map.createdAt,
              view
          ) || []
        : [{ type: 'day', bucket: { label: '', items: sortedMaps } }];

    groupings.forEach((entry) => {
        if (entry.type === 'userGroup') {
            const group = entry.group;
            const items = entry.items || [];
            const gAttr = escapeHtmlAttr(group.id);
            const isGroupSelected = items.length > 0 && items.every((m) => selectedDataIds.has(m.id));
            const collapsed = !!group.collapsed;
            const gInfo = window.manageDataRowInfoButton
                ? window.manageDataRowInfoButton('Group', [
                      { label: 'Type', value: 'Group' },
                      { label: 'Maps', value: String(items.length) },
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
                <td class="data-table-type" style="display: none;" aria-hidden="true"></td>
                <td class="data-table-color" style="display: none;" aria-hidden="true"></td>
                <td class="data-table-actions">
                    ${gInfo}
                    ${T.groupActions(view, group.id, 'Delete this group? Maps will not be deleted.')}
                </td>
            </tr>
        `;
            if (!collapsed) items.forEach((map) => { html += rowForMap(map, true); });
            return;
        }
        if (entry.type === 'day') {
            const bucket = entry.bucket;
            if (utils.renderDataTableDateSectionRow && bucket.label) {
                html += utils.renderDataTableDateSectionRow(bucket.label, bucket.items.length, 'map');
            }
            bucket.items.forEach((map) => { html += rowForMap(map, false); });
        }
    });
    tbody.innerHTML = html;
    renderAccessibleAerialPagination(pagination);
}

window.aerialMapsTableRenderer = {
    renderAerialMapsTable,
};
