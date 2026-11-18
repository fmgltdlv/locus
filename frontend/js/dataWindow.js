// Data Window module - Window UI management (open/close, resize, view switching)

// Data Window state
let dataWindowResizing = false;
let dataWindowResizeStart = { x: 0, y: 0, width: 0, height: 0 };
let currentDataView = 'annotations'; // 'annotations', 'layers', 'photos', 'documents', 'aerialmaps', or 'events'
let lastDataView = 'annotations'; // Track last active tab for restoration
let isDeleting = false; // Flag to prevent window from closing during delete operations
let isEditingName = false; // Flag to prevent window from closing when finishing rename (e.g. prompt dialog)
let dataHubBusyCount = 0;

const DATA_WINDOW_VIEWPORT_GUTTER = 12;
const DATA_WINDOW_MIN_HEIGHT = 280;
const DATA_WINDOW_MAX_HEIGHT = 1200;

/** Which Manage Data table columns are visible per tab (type = Type/utility, color = Utility/Items/Details/Size). */
function getDataHubColumnVisibility(view) {
    switch (view) {
        case 'annotations':
            return { type: false, color: true };
        case 'layers':
            return { type: true, color: false };
        case 'photos':
            return { type: false, color: false };
        case 'documents':
            return { type: false, color: false };
        case 'aerialmaps':
            return { type: false, color: false };
        case 'events':
            return { type: false, color: false };
        default:
            return { type: true, color: true };
    }
}

function isDataWindowDesktop() {
    return typeof window !== 'undefined' && window.innerWidth > 768;
}

function getDataWindowProfileStorageKey() {
    let storageKey = 'userProfile';
    if (window.authModule && window.authModule.isAuthenticated()) {
        const user = window.authModule.getCurrentUser();
        if (user && user.id) {
            storageKey = `userProfile_user_${user.id}`;
        }
    }
    return storageKey;
}

function getDataWindowViewportLimits() {
    const vh = typeof window !== 'undefined' ? window.innerHeight || 0 : 0;
    const maxHeight = Math.max(DATA_WINDOW_MIN_HEIGHT, vh - DATA_WINDOW_VIEWPORT_GUTTER * 2);
    return {
        minHeight: Math.min(DATA_WINDOW_MIN_HEIGHT, maxHeight),
        maxHeight: Math.min(DATA_WINDOW_MAX_HEIGHT, maxHeight),
    };
}

function clearDataWindowInlineLayout(el) {
    if (!el) return;
    el.style.width = '';
    el.style.height = '';
    el.style.left = '';
    el.style.top = '';
    el.style.transform = '';
    el.style.minWidth = '';
    el.style.minHeight = '';
    el.style.maxWidth = '';
    el.style.maxHeight = '';
}

function clampDataWindowHeight(el) {
    if (!el || !isDataWindowDesktop()) return;
    const limits = getDataWindowViewportLimits();
    const rect = el.getBoundingClientRect();
    const styleHeight = parseFloat(el.style.height || '');
    const height = Math.max(
        limits.minHeight,
        Math.min(limits.maxHeight, styleHeight || rect.height || limits.maxHeight)
    );
    el.style.height = height + 'px';
    el.style.maxHeight = height + 'px';
}

function isTicketHubWindowOpen() {
    const hub = document.getElementById('ticketHubWindow');
    return !!(hub && hub.classList.contains('show'));
}

/** Keep Manage Data above Ticket Hub when both are open (hub z-index 60001). */
function syncDataWindowStackAboveHub() {
    const dataWindow = document.getElementById('dataWindow');
    if (!dataWindow) return;
    const stack = dataWindow.classList.contains('show') && isTicketHubWindowOpen();
    dataWindow.classList.toggle('data-window-stack-above-hub', stack);
}

const DATA_HUB_BACK_ID = 'dataHub';

function isDataHubPanelOpen() {
    const dataWindow = document.getElementById('dataWindow');
    return !!(dataWindow && dataWindow.classList.contains('show'));
}

function registerDataHubBack() {
    if (!window.uiBackStack) return;
    window.uiBackStack.register({
        id: DATA_HUB_BACK_ID,
        isOpen: isDataHubPanelOpen,
        onBack: function () {
            closeDataWindow({ fromBack: true });
        },
    });
}

function unregisterDataHubBack(fromBack) {
    if (!window.uiBackStack || !window.uiBackStack.isRegistered(DATA_HUB_BACK_ID)) return;
    window.uiBackStack.unregister(DATA_HUB_BACK_ID, fromBack ? { fromPopstate: true } : undefined);
}

function ensureDataHubBusyOverlay() {
    const container = document.querySelector('#dataWindow .data-table-container');
    if (!container) return null;
    let overlay = container.querySelector('.data-hub-busy-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'data-hub-busy-overlay';
        overlay.hidden = true;
        overlay.innerHTML =
            '<div class="data-hub-busy-inner" role="status" aria-live="polite">' +
            (typeof window.getAppLoaderHtml === 'function' ? window.getAppLoaderHtml({ decorative: true }) : '<div class="app-loading-indicator" aria-hidden="true"></div>') +
            '<p class="data-hub-busy-text ticket-hub-loading-text"></p>' +
            '</div>';
        container.appendChild(overlay);
    }
    return overlay;
}

function setDataHubBusy(busy, message) {
    const container = document.querySelector('#dataWindow .data-table-container');
    if (!container) return;
    if (busy) {
        dataHubBusyCount += 1;
    } else {
        dataHubBusyCount = Math.max(0, dataHubBusyCount - 1);
    }
    const overlay = ensureDataHubBusyOverlay();
    if (!overlay) return;
    const textEl = overlay.querySelector('.data-hub-busy-text');
    if (textEl && message) {
        textEl.textContent = message;
    } else if (textEl && busy && !textEl.textContent) {
        textEl.textContent = 'Working…';
    }
    const show = dataHubBusyCount > 0;
    overlay.hidden = !show;
    container.classList.toggle('data-hub-busy', show);
    container.setAttribute('aria-busy', show ? 'true' : 'false');
}

function updateDataHubBusyMessage(message) {
    const textEl = document.querySelector('#dataWindow .data-hub-busy-text');
    if (textEl && message) {
        textEl.textContent = message;
    }
}

function isDataHubBusy() {
    return dataHubBusyCount > 0;
}

function openDataWindow(viewToRestore) {
    if (window.CORE_PRODUCT === true) return;
    const dataWindow = document.getElementById('dataWindow');
    if (dataWindow) {
        const viewToUse = viewToRestore || lastDataView || 'annotations';

        if (typeof window.clearDataHubSearch === 'function') {
            window.clearDataHubSearch(viewToUse);
        }

        if (isDataWindowDesktop()) {
            clearDataWindowInlineLayout(dataWindow);
            loadDataWindowDimensions(dataWindow);
            clampDataWindowHeight(dataWindow);
        } else {
            loadDataWindowDimensions(dataWindow);
        }

        dataWindow.classList.add('show');
        syncDataWindowStackAboveHub();
        if (typeof window.renderHubStats === 'function') {
            window.renderHubStats();
        }
        // Restore to specified view, or last active view, or default to annotations
        currentDataView = viewToUse;
        lastDataView = viewToUse;
        
        // Initialize mobile dropdown if it exists
        const mobileDropdown = document.getElementById('dataViewDropdown');
        if (mobileDropdown) {
            mobileDropdown.value = viewToUse;
        }
        
        switchDataView(viewToUse);
        
        if (window.dataTableRendererModule && window.dataTableRendererModule.refreshDataWindow) {
            window.dataTableRendererModule.refreshDataWindow();
        }
        
        // Desktop: bottom-sheet height resize (same pattern as Ticket Hub)
        if (isDataWindowDesktop()) {
            initDataWindowTopResize();
        }

        if (typeof window.syncDataHubMapFilterIndicator === 'function') {
            window.syncDataHubMapFilterIndicator();
        }
        registerDataHubBack();
    }
}

function syncDataHubMobileColgroup(table, view, isMobile) {
    if (!table) return;
    let colgroup = table.querySelector('colgroup.data-table-mobile-cols');
    if (!isMobile) {
        if (colgroup) colgroup.remove();
        return;
    }
    if (!colgroup) {
        colgroup = document.createElement('colgroup');
        colgroup.className = 'data-table-mobile-cols';
        table.insertBefore(colgroup, table.firstChild);
    }
    const isPhotos = view === 'photos';
    const classNames = isPhotos
        ? [
              'data-table-col-photo-leading',
              'data-table-col-hidden',
              'data-table-col-name',
              'data-table-col-hidden',
              'data-table-col-hidden',
              'data-table-col-photo-actions',
          ]
        : [
              'data-table-col-checkbox',
              'data-table-col-hidden',
              'data-table-col-name',
              'data-table-col-hidden',
              'data-table-col-hidden',
              'data-table-col-actions',
          ];
    colgroup.replaceChildren(
        ...classNames.map((className) => {
            const col = document.createElement('col');
            col.className = className;
            return col;
        })
    );
}

function syncManageDataTableThead() {
    const table = document.querySelector('#dataWindow .data-table');
    const thead = document.querySelector('#dataWindow .data-table thead');
    if (!thead) return;
    const view = currentDataView;
    const isMobile = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches;
    const thumbHeader = thead.querySelector('th.data-table-thumb');
    const nameHeader = thead.querySelector('th.data-table-name');
    if (table) {
        const colVis = getDataHubColumnVisibility(view);
        table.classList.toggle('data-table--photos-view', view === 'photos');
        table.classList.toggle('data-table--annotations-view', view === 'annotations');
        table.classList.toggle('data-table--hide-type-col', !colVis.type);
        table.classList.toggle('data-table--hide-color-col', !colVis.color);
        table.classList.toggle(
            'data-table--hide-mobile-thumb',
            isMobile && view !== 'photos'
        );
        table.classList.toggle('data-table--mobile', isMobile);
        syncDataHubMobileColgroup(table, view, isMobile);
    }

    if (view === 'photos') {
        thead.style.display = '';
        thead.querySelectorAll('th').forEach((th) => {
            if (th.classList.contains('data-table-checkbox')) {
                th.style.display = '';
                th.style.visibility = '';
                th.removeAttribute('aria-hidden');
            } else {
                th.style.display = 'none';
                th.setAttribute('aria-hidden', 'true');
            }
        });
        return;
    }

    thead.querySelectorAll('th').forEach((th) => {
        if (th.style.display === 'none' && !th.classList.contains('data-table-thumb')) {
            th.style.display = '';
            th.removeAttribute('aria-hidden');
        }
    });
    thead.style.display = isMobile ? 'block' : 'table-header-group';
    const checkboxHeader = thead.querySelector('th.data-table-checkbox');
    if (thumbHeader && nameHeader) {
        const mergeThumbIntoLeading = false;
        const hideMobileThumbCol = isMobile && view !== 'photos';
        const hideThumbCol = view === 'annotations' || hideMobileThumbCol;
        if (mergeThumbIntoLeading) {
            /* Photos mobile: select-all in col 1; col 2 thumb header collapsed */
            if (checkboxHeader) {
                checkboxHeader.style.display = '';
                checkboxHeader.style.visibility = '';
                checkboxHeader.removeAttribute('aria-hidden');
            }
            thumbHeader.style.display = 'none';
            thumbHeader.style.visibility = '';
            thumbHeader.style.padding = '';
            thumbHeader.style.width = '';
            thumbHeader.textContent = '';
            thumbHeader.setAttribute('aria-hidden', 'true');
            nameHeader.colSpan = 1;
        } else if (hideThumbCol) {
            if (checkboxHeader) {
                checkboxHeader.style.display = '';
                checkboxHeader.style.visibility = '';
                checkboxHeader.removeAttribute('aria-hidden');
            }
            thumbHeader.style.display = 'none';
            thumbHeader.setAttribute('aria-hidden', 'true');
            nameHeader.colSpan = 1;
        } else {
            if (checkboxHeader) {
                checkboxHeader.style.display = '';
                checkboxHeader.style.visibility = '';
                checkboxHeader.removeAttribute('aria-hidden');
            }
            thumbHeader.style.display = '';
            thumbHeader.style.visibility = '';
            thumbHeader.style.padding = '';
            thumbHeader.style.width = '';
            thumbHeader.removeAttribute('aria-hidden');
            nameHeader.colSpan = 1;
        }
    }
}

function closeDataWindow(opts) {
    const options = opts || {};
    const dataWindow = document.getElementById('dataWindow');
    if (dataWindow) {
        // Save current dimensions to profile before closing
        saveDataWindowDimensions(dataWindow);
        
        dataWindow.classList.remove('show');
        dataWindow.classList.remove('data-window-stack-above-hub');
        if (typeof window.renderHubStats === 'function') {
            window.renderHubStats();
        }
        
        // Clear ticket filter when closing
        if (window.dataWindowModule) {
            window.dataWindowModule.filterTicketId = null;
            window.dataWindowModule.filterTicketNumber = null;
        }
        if (window.aerialMapsModule?.syncAccessibleAerialToolbar) {
            window.aerialMapsModule.syncAccessibleAerialToolbar();
        }

        if (typeof window.syncDataHubMapFilterIndicator === 'function') {
            window.syncDataHubMapFilterIndicator();
        }
    }
    unregisterDataHubBack(options.fromBack);
}

function initDataWindowTopResize() {
    const dataWindow = document.getElementById('dataWindow');
    const top = dataWindow && dataWindow.querySelector('#dataWindowResizeHandleTop, .data-window-resize-top');
    if (!dataWindow || !top || dataWindow.dataset.dataWindowResizeInit) return;
    dataWindow.dataset.dataWindowResizeInit = '1';

    top.addEventListener('mousedown', function (e) {
        e.stopPropagation();
        dataWindowResizing = true;
        const rect = dataWindow.getBoundingClientRect();
        dataWindowResizeStart = {
            x: e.clientX,
            y: e.clientY,
            width: rect.width,
            height: rect.height,
            top: rect.top,
        };
        dataWindow.classList.add('resizing');
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', function dataWindowResizeMove(e) {
        if (!dataWindowResizing) return;
        const win = document.getElementById('dataWindow');
        if (!win) return;
        const deltaY = dataWindowResizeStart.y - e.clientY;
        const limits = getDataWindowViewportLimits();
        const h = Math.max(
            limits.minHeight,
            Math.min(limits.maxHeight, dataWindowResizeStart.height + deltaY)
        );
        win.style.height = h + 'px';
        win.style.maxHeight = h + 'px';
        // Top-anchored layout: keep the bottom edge fixed while the top follows the pointer.
        if (win.style.top) {
            const gutter = DATA_WINDOW_VIEWPORT_GUTTER;
            const newTop = (dataWindowResizeStart.top || 0) + (dataWindowResizeStart.height - h);
            const maxTop = Math.max(gutter, window.innerHeight - h - gutter);
            win.style.top = Math.max(gutter, Math.min(maxTop, newTop)) + 'px';
            win.style.bottom = 'auto';
        }
    });

    document.addEventListener('mouseup', function dataWindowResizeUp() {
        if (!dataWindowResizing) return;
        dataWindowResizing = false;
        const win = document.getElementById('dataWindow');
        if (win) {
            win.classList.remove('resizing');
            saveDataWindowDimensions(win);
        }
        document.body.style.userSelect = '';
    });
}

function switchDataView(view) {
    currentDataView = view;
    lastDataView = view; // Update last active view
    if (window.tableSortingModule && window.tableSortingModule.normalizeManageDataSortForView) {
        window.tableSortingModule.normalizeManageDataSortForView(view);
    }
    if (window.dataSelectionModule) {
        window.dataSelectionModule.clearSelection();
    }
    
    // Clear ticket filter when switching away from events view
    if (view !== 'events' && window.dataWindowModule) {
        window.dataWindowModule.filterTicketId = null;
        window.dataWindowModule.filterTicketNumber = null;
    }
    
    // Clear document query results when switching away from documents view
    if (view !== 'documents') {
        window.documentQueryResults = null;
    }
    
    // Update tab button active state via CSS class
    const annotationsBtn = document.getElementById('dataViewAnnotations');
    const layersBtn = document.getElementById('dataViewLayers');
    const photosBtn = document.getElementById('dataViewPhotos');
    const documentsBtn = document.getElementById('dataViewDocuments');
    const aerialMapsBtn = document.getElementById('dataViewAerialMaps');
    const eventsBtn = document.getElementById('dataViewEvents');
    const allButtons = [annotationsBtn, layersBtn, photosBtn, documentsBtn, aerialMapsBtn, eventsBtn];
    const viewButtonMap = {
        annotations: annotationsBtn,
        layers: layersBtn,
        photos: photosBtn,
        documents: documentsBtn,
        aerialmaps: aerialMapsBtn,
        events: eventsBtn,
    };
    allButtons.forEach((btn) => {
        if (!btn) return;
        const isActive = btn === viewButtonMap[view];
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    const mobileDropdown = document.getElementById('dataViewDropdown');
    if (mobileDropdown) {
        mobileDropdown.value = view;
    }
    
    // Show/hide type filter based on view
    if (window.dataHubFiltersModule?.syncToolbarControls) {
        window.dataHubFiltersModule.syncToolbarControls(view);
    }
    if (window.dataHubFiltersModule?.syncPanelForView) {
        window.dataHubFiltersModule.syncPanelForView(view);
    }
    if (window.photosBatchesPanelModule?.syncBatchesButtonVisibility) {
        window.photosBatchesPanelModule.syncBatchesButtonVisibility(view);
    }
    
    // Update visible table header labels based on view
    const colVis = getDataHubColumnVisibility(view);
    const colorHeaderText = document.getElementById('colorHeaderText');
    if (colVis.color && colorHeaderText) {
        colorHeaderText.textContent = 'Utility';
    }
    
    // Show/hide table headers based on view
    const table = document.querySelector('.data-table');
    if (table) {
        syncManageDataTableThead();
    }
    
    // Photos / Documents / Events: refresh table after async server hydration (see branches below).

    function refreshTableAfterView() {
        if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
            window.dataTableRendererModule.renderDataTable();
        }
        if (window.updateSortIndicators) {
            setTimeout(() => {
                window.updateSortIndicators();
            }, 50);
        }
    }

    if (view === 'aerialmaps') {
        refreshTableAfterView();
    } else if (view === 'photos' && window.photosModule && window.photosModule.ensureManageDataPhotosLoaded) {
        void window.photosModule
            .ensureManageDataPhotosLoaded()
            .then(() => refreshTableAfterView())
            .catch((err) => {
                console.warn('[dataWindow] photos tab load:', err.message || err);
                refreshTableAfterView();
            });
    } else if (view === 'documents' && window.documentsModule && window.documentsModule.ensureManageDataDocumentsLoaded) {
        void window.documentsModule.ensureManageDataDocumentsLoaded().then(() => refreshTableAfterView());
    } else if (view === 'events' && window.reportedEventsStore && window.reportedEventsStore.ensureLoaded) {
        void window.reportedEventsStore.ensureLoaded().then(() => refreshTableAfterView());
    } else if (view === 'layers' && window.annotationStorageModule && window.annotationStorageModule.ensureSavedDataLayersLoaded) {
        void window.annotationStorageModule.ensureSavedDataLayersLoaded().then(() => refreshTableAfterView());
    } else {
        refreshTableAfterView();
    }

    if (window.aerialMapsModule?.syncAccessibleAerialToolbar) {
        window.aerialMapsModule.syncAccessibleAerialToolbar();
    }

    syncDataFilterContextBanner();
}

function syncDataFilterContextBanner() {
    const banner = document.getElementById('dataFilterContextBanner');
    const textEl = document.getElementById('dataFilterContextText');
    if (!banner || !textEl) return;

    const view = currentDataView;
    const windowModule = window.dataWindowModule;
    let message = '';
    let show = false;

    if (view === 'documents' && window.documentQueryResults && window.documentQueryResults.length > 0) {
        const count = window.documentQueryResults.length;
        message = `Showing ${count} document${count === 1 ? '' : 's'} from location search.`;
        show = true;
    } else if (view === 'photos' && window.photosBatchesPanelModule?.getActiveBatchId?.()) {
        const batchMsg = window.photosBatchesPanelModule.getBatchBannerMessage?.() || 'Batch filter active.';
        const filterMsg = window.dataHubFiltersModule?.hasActiveFilters?.(view)
            ? window.dataHubFiltersModule.getFilterSummaryText(view)
            : '';
        message = filterMsg ? `${batchMsg} ${filterMsg}` : batchMsg;
        show = true;
    } else if (window.dataHubFiltersModule?.hasActiveFilters?.(view)) {
        message = window.dataHubFiltersModule.getFilterSummaryText(view);
        show = !!message;
    } else if (view === 'events' && windowModule) {
        const ticketNum = windowModule.filterTicketNumber;
        const ticketId = windowModule.filterTicketId;
        if (
            (ticketNum != null && ticketNum !== '') ||
            (ticketId != null && ticketId !== '')
        ) {
            const label =
                ticketNum != null && ticketNum !== ''
                    ? String(ticketNum)
                    : ticketId != null && ticketId !== ''
                      ? String(ticketId)
                      : '';
            message = `Showing events for ticket ${label}.`;
            show = true;
        }
    }

    banner.style.display = show ? 'flex' : 'none';
    textEl.textContent = message;
}

function clearDataFilterContext() {
    const view = currentDataView;
    if (view === 'documents' && window.documentQueryResults && window.documentQueryResults.length > 0) {
        window.documentQueryResults = null;
    } else if (view === 'photos' && window.photosBatchesPanelModule?.getActiveBatchId?.()) {
        window.photosBatchesPanelModule.clearActiveBatch();
        if (window.dataHubFiltersModule?.hasActiveFilters?.(view)) {
            window.dataHubFiltersModule.clearFilters(view);
        }
    } else if (window.dataHubFiltersModule?.hasActiveFilters?.(view)) {
        window.dataHubFiltersModule.clearFilters(view);
    } else if (view === 'events' && window.dataWindowModule) {
        window.dataWindowModule.filterTicketId = null;
        window.dataWindowModule.filterTicketNumber = null;
        if (window.dataHubPaginationModule?.resetDataHubPage) {
            window.dataHubPaginationModule.resetDataHubPage('events');
        }
    }
    syncDataFilterContextBanner();
    if (window.dataTableRendererModule?.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
}

// Save data window dimensions to user profile (desktop: height only for bottom sheet)
function saveDataWindowDimensions(dataWindow) {
    try {
        if (!dataWindow || !dataWindow.classList.contains('show')) return;
        if (isDataWindowDesktop()) {
            clampDataWindowHeight(dataWindow);
        }
        const profileData = JSON.parse(localStorage.getItem(getDataWindowProfileStorageKey()) || '{}');
        const rect = dataWindow.getBoundingClientRect();

        if (isDataWindowDesktop()) {
            profileData.dataWindowHeight = rect.height;
            profileData.dataWindowLeft = null;
            profileData.dataWindowTop = null;
            profileData.dataWindowTransform = null;
            profileData.dataWindowWidth = null;
        } else {
            profileData.dataWindowWidth = rect.width;
            profileData.dataWindowHeight = rect.height;
            profileData.dataWindowLeft = dataWindow.style.left || null;
            profileData.dataWindowTop = dataWindow.style.top || null;
            profileData.dataWindowTransform = dataWindow.style.transform || null;
        }

        localStorage.setItem(getDataWindowProfileStorageKey(), JSON.stringify(profileData));
        if (typeof window.schedulePersistUserUiPreferencesToServer === 'function') {
            window.schedulePersistUserUiPreferencesToServer();
        }
    } catch (error) {
        console.error('Error saving data window dimensions:', error);
    }
}

// Load data window dimensions from user profile
function loadDataWindowDimensions(dataWindow) {
    try {
        const profileData = JSON.parse(localStorage.getItem(getDataWindowProfileStorageKey()) || '{}');

        if (isDataWindowDesktop()) {
            if (profileData.dataWindowHeight) {
                const limits = getDataWindowViewportLimits();
                const height = Math.max(
                    limits.minHeight,
                    Math.min(limits.maxHeight, profileData.dataWindowHeight)
                );
                dataWindow.style.height = height + 'px';
                dataWindow.style.maxHeight = height + 'px';
            }
            return;
        }

        if (profileData.dataWindowWidth && profileData.dataWindowHeight) {
            const width = Math.max(600, Math.min(2000, profileData.dataWindowWidth));
            const height = Math.max(400, Math.min(1200, profileData.dataWindowHeight));

            dataWindow.style.width = width + 'px';
            dataWindow.style.height = height + 'px';

            if (profileData.dataWindowLeft && profileData.dataWindowTop) {
                dataWindow.style.left = profileData.dataWindowLeft;
                dataWindow.style.top = profileData.dataWindowTop;
                dataWindow.style.transform = profileData.dataWindowTransform || 'none';
            } else {
                dataWindow.style.left = '';
                dataWindow.style.top = '';
                dataWindow.style.transform = 'translate(-50%, -50%)';
            }
        }
    } catch (error) {
        console.error('Error loading data window dimensions:', error);
    }
}

// Open Data window on Reported Events tab filtered to a specific ticket.
function openDataWindowForTicket(ticketId, ticketNumber) {
    if (window.CORE_PRODUCT === true) return;
    if (window.dataWindowModule) {
        window.dataWindowModule.filterTicketId = ticketId;
        window.dataWindowModule.filterTicketNumber = ticketNumber;
    }
    if (window.dataHubPaginationModule?.resetDataHubPage) {
        window.dataHubPaginationModule.resetDataHubPage('events');
    }
    openDataWindow('events');
}

// Export for use in other modules
window.dataWindowModule = {
    get currentDataView() { return currentDataView; },
    set currentDataView(value) { currentDataView = value; },
    get isDeleting() { return isDeleting; },
    set isDeleting(value) { isDeleting = value; },
    get isEditingName() { return isEditingName; },
    set isEditingName(value) { isEditingName = value; },
    filterTicketId: null,
    filterTicketNumber: null,
    getDataHubColumnVisibility,
    openDataWindow,
    openDataWindowForTicket,
    closeDataWindow,
    switchDataView,
    syncManageDataTableThead,
    syncDataFilterContextBanner,
    clearDataFilterContext,
    setDataHubBusy,
    updateDataHubBusyMessage,
    isDataHubBusy,
};

// Make functions globally available for HTML onclick handlers
window.openDataWindow = openDataWindow;
window.openDataWindowForTicket = openDataWindowForTicket;
window.closeDataWindow = closeDataWindow;
window.syncDataWindowStackAboveHub = syncDataWindowStackAboveHub;
window.switchDataView = switchDataView;
window.syncManageDataTableThead = syncManageDataTableThead;
window.syncDataFilterContextBanner = syncDataFilterContextBanner;
window.clearDataFilterContext = clearDataFilterContext;

let manageDataTheadResizeScheduled = false;
window.addEventListener('resize', () => {
    const dataWindow = document.getElementById('dataWindow');
    if (!dataWindow?.classList.contains('show')) return;
    if (isDataWindowDesktop()) {
        clampDataWindowHeight(dataWindow);
    }
    if (manageDataTheadResizeScheduled) return;
    manageDataTheadResizeScheduled = true;
    requestAnimationFrame(() => {
        manageDataTheadResizeScheduled = false;
        syncManageDataTableThead();
    });
});

