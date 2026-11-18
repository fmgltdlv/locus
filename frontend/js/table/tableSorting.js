// Table sorting module
const sortByView = {};
const DEFAULT_SORT = { column: 'created', direction: 'desc' };

function getActiveView() {
    return window.dataWindowModule?.currentDataView || '';
}

function getDefaultSortForView() {
    return DEFAULT_SORT;
}

function hasExplicitSortForView(view) {
    const v = view || getActiveView();
    const state = sortByView[v];
    return !!(state && state.column);
}

function getSortStateForView(view) {
    const v = view || getActiveView();
    const state = sortByView[v];
    if (!state || !state.column) return { ...getDefaultSortForView() };
    return { column: state.column, direction: state.direction || 'asc' };
}

function setSortStateForView(view, column, direction) {
    const v = view || getActiveView();
    if (!v) return;
    const def = getDefaultSortForView();
    const dir = direction || 'asc';
    if (!column || (column === def.column && dir === def.direction)) {
        delete sortByView[v];
    } else {
        sortByView[v] = { column, direction: dir };
    }
    updateSortIndicators();
    syncManageDataMobileSortUI();
    if (window.dataHubFiltersModule?.syncDesktopSortSelect) {
        window.dataHubFiltersModule.syncDesktopSortSelect?.(v);
    }
}

// Sort data by column
function sortData(data, column, direction, view) {
    if (!data || data.length === 0) return data;
    const activeView = view || getActiveView();

    const sorted = [...data].sort((a, b) => {
        let aValue;
        let bValue;

        switch (column) {
            case 'name':
                aValue = (a.name || a.fileName || a.ticketNumber || '').toLowerCase();
                bValue = (b.name || b.fileName || b.ticketNumber || '').toLowerCase();
                break;
            case 'type':
                aValue = (a.type || '').toLowerCase();
                bValue = (b.type || '').toLowerCase();
                break;
            case 'color':
                aValue = a.color || a.utilityType || '';
                bValue = b.color || b.utilityType || '';
                break;
            case 'created': {
                if (activeView === 'events') {
                    aValue = a.incidentDate ? new Date(a.incidentDate).getTime() : 0;
                    bValue = b.incidentDate ? new Date(b.incidentDate).getTime() : 0;
                } else if (activeView === 'aerialmaps') {
                    const aDate = a.capturedAt || a.createdAt;
                    const bDate = b.capturedAt || b.createdAt;
                    aValue = aDate ? new Date(aDate).getTime() : 0;
                    bValue = bDate ? new Date(bDate).getTime() : 0;
                } else {
                    aValue = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                    bValue = b.createdAt ? new Date(b.createdAt).getTime() : 0;
                }
                break;
            }
            case 'size':
                if (a.fileSize) {
                    aValue = a.fileSize;
                } else if (a.imageUrl) {
                    aValue = window.tableUtilsModule?.calculateDataUrlSize(a.imageUrl) || 0;
                } else {
                    aValue = 0;
                }
                if (b.fileSize) {
                    bValue = b.fileSize;
                } else if (b.imageUrl) {
                    bValue = window.tableUtilsModule?.calculateDataUrlSize(b.imageUrl) || 0;
                } else {
                    bValue = 0;
                }
                break;
            default:
                return 0;
        }

        if (aValue < bValue) return direction === 'asc' ? -1 : 1;
        if (aValue > bValue) return direction === 'asc' ? 1 : -1;
        return 0;
    });

    return sorted;
}

function handleColumnSort(column) {
    const view = getActiveView();
    const current = getSortStateForView(view);
    let direction = 'asc';
    if (current.column === column) {
        direction = current.direction === 'asc' ? 'desc' : 'asc';
    }
    setSortStateForView(view, column, direction);
    if (window.dataHubPaginationModule?.resetDataHubPage) {
        window.dataHubPaginationModule.resetDataHubPage(view);
    }
    if (window.dataTableRendererModule?.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
}

function updateSortIndicators() {
    const view = getActiveView();
    const { column: currentSortColumn, direction: currentSortDirection } = getSortStateForView(view);
    const headers = document.querySelectorAll('.data-table th[data-sortable]');
    headers.forEach((header) => {
        const column = header.dataset.column;
        const indicator = header.querySelector('.sort-indicator');

        if (currentSortColumn === column) {
            header.classList.add('sorted');
            if (indicator) {
                indicator.textContent = currentSortDirection === 'asc' ? '↑' : '↓';
                indicator.style.display = 'inline';
            }
        } else {
            header.classList.remove('sorted');
            if (indicator) {
                indicator.textContent = '↕';
                indicator.style.opacity = '0.3';
            }
        }
    });
    syncManageDataMobileSortUI();
}

function syncManageDataMobileSortUI() {
    const body = document.getElementById('dataSearchFilterBody');
    if (!body) return;
    const { column, direction } = getSortStateForView(getActiveView());
    const val = `${column}:${direction}`;
    const isDateSort = val === 'created:desc' || val === 'created:asc';
    body.querySelectorAll('.data-hub-sort-radio').forEach((r) => {
        r.checked = isDateSort && r.value === val;
    });
    const extra = body.querySelector('#dataHubSortExtra');
    if (extra) {
        extra.value = !isDateSort && val ? val : '';
    }
}

function syncManageDataMobileSortSelectVisibility() {
    /* legacy — sort UI lives in mobile search sheet */
}

function normalizeManageDataSortForView(view) {
    const { column } = getSortStateForView(view);
    if (
        (column === 'size' && view !== 'documents') ||
        (column === 'type' && (view === 'photos' || view === 'aerialmaps' || view === 'events'))
    ) {
        setSortStateForView(view, null, 'asc');
    }
}

function applyManageDataMobileSortFromSelect(raw) {
    const v = raw != null ? String(raw) : '';
    const view = getActiveView();
    if (v === '') {
        setSortStateForView(view, null, 'asc');
    } else {
        const idx = v.indexOf(':');
        if (idx <= 0) return;
        setSortStateForView(view, v.slice(0, idx), v.slice(idx + 1) || 'asc');
    }
    if (window.dataHubPaginationModule?.resetDataHubPage) {
        window.dataHubPaginationModule.resetDataHubPage(view);
    }
    if (window.dataTableRendererModule?.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
}

function applyManageDataMobileSort(column, direction) {
    const view = getActiveView();
    setSortStateForView(view, column, direction || 'asc');
    if (window.dataHubPaginationModule?.resetDataHubPage) {
        window.dataHubPaginationModule.resetDataHubPage(view);
    }
    if (window.dataTableRendererModule?.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
}

function getSortState() {
    return getSortStateForView(getActiveView());
}

function setSortState(column, direction) {
    setSortStateForView(getActiveView(), column, direction);
}

window.tableSortingModule = {
    sortData,
    handleColumnSort,
    updateSortIndicators,
    getSortState,
    setSortState,
    getDefaultSortForView,
    hasExplicitSortForView,
    getSortStateForView,
    setSortStateForView,
    applyManageDataMobileSort,
    applyManageDataMobileSortFromSelect,
    syncManageDataMobileSortUI,
    syncManageDataMobileSortSelectVisibility,
    normalizeManageDataSortForView,
};

window.handleColumnSort = handleColumnSort;
window.updateSortIndicators = updateSortIndicators;
window.applyManageDataMobileSort = applyManageDataMobileSort;
window.applyManageDataMobileSortFromSelect = applyManageDataMobileSortFromSelect;
