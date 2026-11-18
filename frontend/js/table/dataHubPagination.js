// Data Hub pagination — pages by upload-date / user-group / photo-batch groupings (max 20 per page).
// Photos gallery pages by individual photos (50 per page).

const DATA_HUB_GROUPINGS_PAGE_SIZE = 20;
const DATA_HUB_PHOTOS_PAGE_SIZE = 50;
const dataHubPageByView = {};
const dataHubLastSearchByView = {};
/** @type {string[]} Photo ids on the current Photos gallery page (for select-all). */
let photosPageItemIds = [];

function getDataHubPage(view) {
    const page = dataHubPageByView[view];
    return page && page > 0 ? page : 1;
}

function scrollDataHubListToTop() {
    const scrollEl = document.querySelector('#dataWindow .data-table-container');
    if (window.overlayScrollModule && typeof window.overlayScrollModule.scrollToTop === 'function') {
        window.overlayScrollModule.scrollToTop(scrollEl);
        return;
    }
    if (scrollEl) {
        scrollEl.scrollTop = 0;
        scrollEl.scrollLeft = 0;
    }
}

function setDataHubPage(view, page) {
    if (!view) return;
    dataHubPageByView[view] = Math.max(1, Math.floor(Number(page) || 1));
    if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
    scrollDataHubListToTop();
}

function resetDataHubPage(view) {
    if (!view) return;
    dataHubPageByView[view] = 1;
}

const dataHubLastFiltersByView = {};

function resetDataHubPageIfFiltersChanged(view, filterSignature) {
    if (!view) return;
    const sig = filterSignature || '';
    if (dataHubLastFiltersByView[view] !== sig) {
        dataHubPageByView[view] = 1;
        dataHubLastFiltersByView[view] = sig;
    }
}

function resetDataHubPageIfSearchChanged(view, searchTerm) {
    if (!view) return;
    const term = searchTerm || '';
    if (dataHubLastSearchByView[view] !== term) {
        dataHubPageByView[view] = 1;
        dataHubLastSearchByView[view] = term;
    }
}

function paginateDataHubGroupings(view, groupings) {
    const all = Array.isArray(groupings) ? groupings : [];
    const totalGroupings = all.length;
    const totalPages = Math.max(1, Math.ceil(totalGroupings / DATA_HUB_GROUPINGS_PAGE_SIZE));
    let page = getDataHubPage(view);
    if (page > totalPages) {
        page = totalPages;
        dataHubPageByView[view] = page;
    }
    const start = (page - 1) * DATA_HUB_GROUPINGS_PAGE_SIZE;
    const pageGroupings = all.slice(start, start + DATA_HUB_GROUPINGS_PAGE_SIZE);
    return {
        pageGroupings,
        totalGroupings,
        page,
        totalPages,
        rangeStart: totalGroupings === 0 ? 0 : start + 1,
        rangeEnd: totalGroupings === 0 ? 0 : start + pageGroupings.length,
        pageSize: DATA_HUB_GROUPINGS_PAGE_SIZE,
    };
}

/** Paginate a flat item list (Photos gallery: 50 photos per page). */
function paginateDataHubItems(view, items, pageSize) {
    const size = pageSize && pageSize > 0 ? pageSize : DATA_HUB_PHOTOS_PAGE_SIZE;
    const all = Array.isArray(items) ? items : [];
    const totalItems = all.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / size));
    let page = getDataHubPage(view);
    if (page > totalPages) {
        page = totalPages;
        dataHubPageByView[view] = page;
    }
    const start = (page - 1) * size;
    const pageItems = all.slice(start, start + size);
    return {
        pageItems,
        totalItems,
        totalGroupings: totalItems,
        pageGroupings: pageItems,
        page,
        totalPages,
        rangeStart: totalItems === 0 ? 0 : start + 1,
        rangeEnd: totalItems === 0 ? 0 : start + pageItems.length,
        pageSize: size,
    };
}

function setPhotosPageItemIds(ids) {
    photosPageItemIds = Array.isArray(ids) ? ids.map((id) => String(id)) : [];
}

function getPhotosPageItemIds() {
    return photosPageItemIds.slice();
}

/** User-defined groups first, then calendar-day buckets for ungrouped items. */
function buildUserGroupAndDayGroupings(groups, groupToItems, ungroupedItems, getDateValue, view) {
    const utils = window.tableUtilsModule || {};
    const result = [];
    (groups || [])
        .filter((g) => ((groupToItems && groupToItems.get(g.id)) || []).length > 0)
        .forEach((group) => {
            result.push({
                type: 'userGroup',
                group,
                items: groupToItems.get(group.id) || [],
            });
        });
    let dayBuckets = utils.groupDataTableItemsByDay
        ? utils.groupDataTableItemsByDay(ungroupedItems, getDateValue)
        : [{ label: '', items: ungroupedItems || [] }];
    const sortMod = window.tableSortingModule;
    const activeView = view || window.dataWindowModule?.currentDataView;
    const sortState = sortMod?.getSortStateForView ? sortMod.getSortStateForView(activeView) : null;
    if (sortState?.column === 'created' && utils.sortDayBucketsByDate) {
        dayBuckets = utils.sortDayBucketsByDate(dayBuckets, sortState.direction);
    }
    dayBuckets.forEach((bucket) => {
        if (!bucket.items || bucket.items.length === 0) return;
        result.push({ type: 'day', bucket });
    });
    return result;
}

/**
 * Photos gallery: calendar-day buckets only (no user groups / upload batches in the main list).
 * @param {object[]} photos
 */
function buildPhotosDayGroupings(photos) {
    const utils = window.tableUtilsModule || {};
    const result = [];
    let dayBuckets = utils.groupDataTableItemsByDay
        ? utils.groupDataTableItemsByDay(photos || [], (photo) => photo.createdAt)
        : [{ label: '', items: photos || [] }];
    const sortMod = window.tableSortingModule;
    const sortState = sortMod?.getSortStateForView ? sortMod.getSortStateForView('photos') : null;
    if (sortState?.column === 'created' && utils.sortDayBucketsByDate) {
        dayBuckets = utils.sortDayBucketsByDate(dayBuckets, sortState.direction);
    }
    dayBuckets.forEach((bucket) => {
        if (!bucket.items || bucket.items.length === 0) return;
        result.push({ type: 'day', bucket });
    });
    return result;
}

/** @deprecated Prefer buildPhotosDayGroupings — kept for any external callers. */
function buildPhotosGroupings(groups, groupToItems, photosNotInUserGroups, sortedBatches, photosByBatch) {
    const unbatched = (photosNotInUserGroups || []).filter((photo) => {
        if (!photo.batchId) return true;
        return !(sortedBatches || []).some((batch) => String(batch.id) === String(photo.batchId));
    });
    const grouped = [];
    (groups || []).forEach((group) => {
        const items = (groupToItems && groupToItems.get(group.id)) || [];
        items.forEach((p) => grouped.push(p));
    });
    (sortedBatches || []).forEach((batch) => {
        const batchPhotos = photosByBatch && photosByBatch.get(batch.id);
        if (batchPhotos) batchPhotos.forEach((p) => grouped.push(p));
    });
    return buildPhotosDayGroupings(grouped.concat(unbatched));
}

function clearDataHubPagination() {
    const pager = document.getElementById('dataHubPagination');
    if (pager) pager.remove();
}

function renderDataHubPagination(view, slice, opts) {
    const tableContainer = document.querySelector('#dataWindow .data-table-container');
    if (!tableContainer) return;
    const o = opts || {};
    const label = o.label || 'grouping';
    const labelPlural = o.labelPlural || 'groupings';
    const total =
        slice && slice.totalItems != null
            ? slice.totalItems
            : slice && slice.totalGroupings != null
              ? slice.totalGroupings
              : 0;
    const pageSize = (slice && slice.pageSize) || o.pageSize || DATA_HUB_GROUPINGS_PAGE_SIZE;
    if (!slice || total <= pageSize) {
        clearDataHubPagination();
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
    pager.innerHTML = `
        <span class="data-hub-pagination-summary">Showing ${slice.rangeStart}–${slice.rangeEnd} of ${total} ${total === 1 ? label : labelPlural}</span>
        <span class="data-hub-pagination-controls">
            ${T.btn('data-hub-page', { view, page: slice.page - 1 }, 'Previous', { disabled: slice.page <= 1 })}
            <span class="data-hub-pagination-page-label">Page ${slice.page} of ${slice.totalPages}</span>
            ${T.btn('data-hub-page', { view, page: slice.page + 1 }, 'Next', { disabled: slice.page >= slice.totalPages })}
        </span>
    `;
}

window.dataHubPaginationModule = {
    DATA_HUB_GROUPINGS_PAGE_SIZE,
    DATA_HUB_PHOTOS_PAGE_SIZE,
    getDataHubPage,
    setDataHubPage,
    resetDataHubPage,
    resetDataHubPageIfSearchChanged,
    resetDataHubPageIfFiltersChanged,
    paginateDataHubGroupings,
    paginateDataHubItems,
    buildUserGroupAndDayGroupings,
    buildPhotosGroupings,
    buildPhotosDayGroupings,
    setPhotosPageItemIds,
    getPhotosPageItemIds,
    clearDataHubPagination,
    renderDataHubPagination,
    scrollDataHubListToTop,
};

window.setDataHubPage = setDataHubPage;
