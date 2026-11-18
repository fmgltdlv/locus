// Data module - Main orchestrator for data window functionality
// This module coordinates all data-related modules

// Initialize data window
function initDataWindow() {
    // This is called from app.js after modules are loaded
    // The data window is initialized when opened
}

// Refresh data window (called by other modules)
let dataHubRefreshInFlight = null;

async function refreshDataWindow() {
    if (dataHubRefreshInFlight) return dataHubRefreshInFlight;
    dataHubRefreshInFlight = (async function () {
        const view = window.dataWindowModule?.currentDataView || 'annotations';
        const refreshBtn = document.getElementById('dataHubRefreshButton');
        if (window.dataWindowModule?.setDataHubBusy) {
            window.dataWindowModule.setDataHubBusy(true, 'Refreshing…');
        }
        if (refreshBtn) {
            refreshBtn.disabled = true;
            refreshBtn.setAttribute('aria-busy', 'true');
        }
        try {
            if (view === 'photos' && window.photosModule) {
                if (typeof window.photosModule.invalidateManageDataPhotosSync === 'function') {
                    window.photosModule.invalidateManageDataPhotosSync();
                }
                if (typeof window.photosModule.ensureManageDataPhotosLoaded === 'function') {
                    await window.photosModule.ensureManageDataPhotosLoaded();
                }
                if (typeof window.photosModule.reloadPhotosOnMap === 'function') {
                    window.photosModule.reloadPhotosOnMap();
                }
            } else if (view === 'documents' && window.documentsModule) {
                if (typeof window.documentsModule.invalidateManageDataDocumentsSync === 'function') {
                    window.documentsModule.invalidateManageDataDocumentsSync();
                }
                if (typeof window.documentsModule.ensureManageDataDocumentsLoaded === 'function') {
                    await window.documentsModule.ensureManageDataDocumentsLoaded();
                }
            } else if (view === 'aerialmaps' && window.aerialMapsModule) {
                if (
                    window.aerialMapsModule.accessibleAerialSearchBbox &&
                    window.aerialMapsModule.loadAccessibleAerialMaps
                ) {
                    await window.aerialMapsModule.loadAccessibleAerialMaps();
                } else if (window.aerialMapsModule.syncAccessibleAerialToolbar) {
                    window.aerialMapsModule.syncAccessibleAerialToolbar();
                }
            } else if (view === 'events' && window.reportedEventsStore) {
                if (typeof window.reportedEventsStore.invalidate === 'function') {
                    window.reportedEventsStore.invalidate();
                }
                if (typeof window.reportedEventsStore.ensureLoaded === 'function') {
                    await window.reportedEventsStore.ensureLoaded();
                }
            }
            if (window.dataTableRendererModule?.renderDataTable) {
                window.dataTableRendererModule.renderDataTable();
            }
        } catch (err) {
            console.warn('[dataHub] refresh:', err.message || err);
            if (window.dataTableRendererModule?.renderDataTable) {
                window.dataTableRendererModule.renderDataTable();
            }
        } finally {
            if (window.dataWindowModule?.setDataHubBusy) {
                window.dataWindowModule.setDataHubBusy(false);
            }
            if (refreshBtn) {
                refreshBtn.disabled = false;
                refreshBtn.removeAttribute('aria-busy');
            }
        }
    })().finally(function () {
        dataHubRefreshInFlight = null;
    });
    return dataHubRefreshInFlight;
}

// Filter data table
function filterDataTable() {
    if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
}

function clearDataHubSearch(view) {
    const mainInput = document.getElementById('dataSearchInput');
    const mobileInput = document.getElementById('dataSearchInputMobile');
    if (mainInput) mainInput.value = '';
    if (mobileInput) mobileInput.value = '';
    const v = view || window.dataWindowModule?.currentDataView;
    if (v && window.dataHubPaginationModule?.resetDataHubPageIfSearchChanged) {
        window.dataHubPaginationModule.resetDataHubPageIfSearchChanged(v, '');
    }
    if (window.dataHubFiltersModule?.syncSearchIconBadge) {
        window.dataHubFiltersModule.syncSearchIconBadge();
    }
}

function openDataSearchModal() {
    const overlay = document.getElementById('dataSearchModalOverlay');
    const mobileInput = document.getElementById('dataSearchInputMobile');
    const mainInput = document.getElementById('dataSearchInput');
    if (!overlay || !mobileInput || !mainInput) return;
    const view = window.dataWindowModule?.currentDataView || 'annotations';
    mobileInput.value = mainInput.value;
    if (window.dataHubFiltersModule) {
        window.dataHubFiltersModule.resetDraftFromApplied?.(view);
        window.dataHubFiltersModule.renderFiltersPanel?.(view, document.getElementById('dataSearchFilterBody'));
        window.dataHubFiltersModule.updateMobileSearchTitle?.(view);
    }
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    if (!window._dataSearchModalEscapeBound) {
        window._dataSearchModalEscapeBound = true;
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            const o = document.getElementById('dataSearchModalOverlay');
            if (o && o.classList.contains('is-open')) {
                e.preventDefault();
                closeDataSearchModal();
            }
        });
    }
    setTimeout(function () {
        mobileInput.focus();
        try {
            mobileInput.select();
        } catch (err) { /* ignore */ }
    }, 50);
}

function closeDataSearchModal() {
    const overlay = document.getElementById('dataSearchModalOverlay');
    if (!overlay) return;
    if (window.dataHubFiltersModule?.applyMobileSearchSheet) {
        window.dataHubFiltersModule.applyMobileSearchSheet();
    }
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
    if (window.dataTableRendererModule?.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
    if (window.dataHubFiltersModule?.syncSearchIconBadge) {
        window.dataHubFiltersModule.syncSearchIconBadge();
    }
}

function onDataSearchModalInput() {
    const mobileInput = document.getElementById('dataSearchInputMobile');
    const mainInput = document.getElementById('dataSearchInput');
    if (!mobileInput || !mainInput) return;
    mainInput.value = mobileInput.value;
    filterDataTable();
}

function clearDataSearchModal() {
    const mobileInput = document.getElementById('dataSearchInputMobile');
    const mainInput = document.getElementById('dataSearchInput');
    const view = window.dataWindowModule?.currentDataView;
    if (mainInput) mainInput.value = '';
    if (mobileInput) mobileInput.value = '';
    if (window.dataHubFiltersModule?.clearFilters && view) {
        window.dataHubFiltersModule.clearFilters(view);
    }
    if (window.tableSortingModule?.setSortStateForView && view) {
        window.tableSortingModule.setSortStateForView(view, null, 'asc');
    }
    const body = document.getElementById('dataSearchFilterBody');
    if (body && window.dataHubFiltersModule?.renderFiltersPanel && view) {
        window.dataHubFiltersModule.renderFiltersPanel(view, body);
    }
    filterDataTable();
    if (window.dataHubFiltersModule?.syncSearchIconBadge) {
        window.dataHubFiltersModule.syncSearchIconBadge();
    }
}

// View data item (annotation)
function viewDataItem(id) {
    // Get annotations from annotations module
    const annotations = window.annotationStorageModule?.annotations || [];
    const annotation = annotations.find(a => a.id === id);
    if (!annotation) return;
    
    // Close data window
    if (window.dataWindowModule && window.dataWindowModule.closeDataWindow) {
        window.dataWindowModule.closeDataWindow();
    }
    
    // Zoom to annotation on map
    const map = window.map;
    if (map && annotation.geometry) {
        let bounds;
        
        if (annotation.type === 'point' && annotation.geometry.coordinates) {
            const [lng, lat] = annotation.geometry.coordinates;
            map.setView([lat, lng], 16);
        } else if (annotation.type === 'line' && annotation.geometry.coordinates) {
            const coords = annotation.geometry.coordinates.map(c => [c[1], c[0]]);
            bounds = L.latLngBounds(coords);
            map.fitBounds(bounds, { padding: [50, 50] });
        } else if (annotation.type === 'polygon' && annotation.geometry.coordinates && annotation.geometry.coordinates[0]) {
            const coords = annotation.geometry.coordinates[0].map(c => [c[1], c[0]]);
            bounds = L.latLngBounds(coords);
            map.fitBounds(bounds, { padding: [50, 50] });
        }
    }
    
    // Open annotation popup if possible
    const annotationLayers = window.annotationRendererModule?.annotationLayers || [];
    const layer = annotationLayers.find(l => {
        return l._annotationId === id;
    });
    
    if (layer && typeof layer.openPopup === 'function') {
        layer.openPopup();
    }
}

// Delete data item (annotation)
async function deleteDataItem(id) {
    const windowModule = window.dataWindowModule;
    if (window.orgDataPermissionsModule && !window.orgDataPermissionsModule.canDeleteOrgData()) {
        await appAlert('You do not have permission to delete data in this organization.');
        return;
    }
    if (windowModule) {
        windowModule.isDeleting = true;
    }
    
    if (!(await appConfirm('Are you sure you want to delete this data item?'))) {
        if (windowModule) {
            windowModule.isDeleting = false;
        }
        return;
    }
    
    // Delete annotation using internal function (no additional confirmation)
    if (window.annotationStorageModule && window.annotationStorageModule.deleteAnnotationInternal) {
        window.annotationStorageModule.deleteAnnotationInternal(id);
    }
    
    if (window.dataSelectionModule) {
        window.dataSelectionModule.selectedDataIds.delete(id);
        window.dataSelectionModule.updateBulkActionsVisibility();
    }
    
    refreshDataWindow();
    
    // Reset flag after a short delay to allow UI to update
    setTimeout(() => {
        if (windowModule) {
            windowModule.isDeleting = false;
        }
    }, 100);
}

// Load data layer
async function loadDataLayer(layerId) {
    // Get saved data layers from annotations module
    const savedLayers = window.annotationStorageModule?.savedDataLayers || [];
    const layer = savedLayers.find(l => l.id === layerId);
    
    if (!layer || !layer.annotations) {
        await appAlert('Data layer not found!');
        return;
    }
    
    // Render the data layer on the map as its own layer (not as annotations)
    if (window.layerManagerModule) {
        layer.isVisible = true;
        layer.listInLayerPanel = true;
        
        // Render the data layer
        if (window.layerManagerModule.renderDataLayer) {
            window.layerManagerModule.renderDataLayer(layer);
        }
        
        // Add to layer control if not already there
        if (window.layerManagerModule.addDataLayerToControl) {
            window.layerManagerModule.addDataLayerToControl(layer);
        }
        
        // Update layer control
        if (window.layerManagerModule.updateLayerControlOverlays) {
            window.layerManagerModule.updateLayerControlOverlays();
        }
        
        // Save the updated visibility state
        if (window.annotationStorageModule && window.annotationStorageModule.saveDataLayers) {
            window.annotationStorageModule.saveDataLayers();
        }

        if (window.layerManagerModule.zoomToDataLayer) {
            window.layerManagerModule.zoomToDataLayer(layerId);
        }
        
        await appAlert(`Loaded "${layer.name}" with ${layer.annotations.length} item(s) as a data layer on the map!`);
    }
}

/** Load one data layer onto the map without a per-layer alert (for bulk load). */
function loadDataLayerSilent(layerId) {
    const savedLayers = window.annotationStorageModule?.savedDataLayers || [];
    const layer = savedLayers.find((l) => l.id === layerId);
    if (!layer || !layer.annotations || !window.layerManagerModule) return false;

    layer.isVisible = true;
    layer.listInLayerPanel = true;

    if (window.layerManagerModule.renderDataLayer) {
        window.layerManagerModule.renderDataLayer(layer);
    }
    if (window.layerManagerModule.addDataLayerToControl) {
        window.layerManagerModule.addDataLayerToControl(layer);
    }
    if (window.layerManagerModule.updateLayerControlOverlays) {
        window.layerManagerModule.updateLayerControlOverlays();
    }
    if (window.annotationStorageModule?.saveDataLayers) {
        window.annotationStorageModule.saveDataLayers();
    }
    if (window.layerManagerModule.zoomToDataLayer) {
        window.layerManagerModule.zoomToDataLayer(layerId);
    }
    return true;
}

async function bulkLoadSelectedLayers() {
    const windowModule = window.dataWindowModule;
    if (!windowModule || windowModule.currentDataView !== 'layers') return;

    const selected = window.dataSelectionModule?.selectedDataIds;
    const ids = selected ? Array.from(selected) : [];
    if (ids.length === 0) {
        await appAlert('No layers selected.');
        return;
    }

    let loaded = 0;
    ids.forEach((id) => {
        if (loadDataLayerSilent(id)) loaded += 1;
    });

    if (window.dataTableRendererModule?.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }

    await appAlert(
        loaded === ids.length
            ? `Loaded ${loaded} data layer${loaded === 1 ? '' : 's'} onto the map.`
            : `Loaded ${loaded} of ${ids.length} selected layer(s). Some layers were not found.`
    );
}

// View data layer
async function viewDataLayer(layerId) {
    // Get saved data layers from annotations module
    const savedLayers = window.annotationStorageModule?.savedDataLayers || [];
    const layer = savedLayers.find(l => l.id === layerId);
    
    if (!layer) {
        await appAlert('Data layer not found!');
        return;
    }
    
    const annotationCount = layer.annotations ? layer.annotations.length : 0;
    const createdDate = window.formatRecordedDateTime(layer.createdAt);
    
    await appAlert(`Data Layer: ${layer.name}\n\nCreated: ${createdDate}\nAnnotations: ${annotationCount}\n\nClick "Load" to load this layer onto the map.`);
}

// Internal delete function without confirmation (for bulk operations)
function deleteDataLayerInternal(layerId) {
    // Delete from annotations module
    if (window.annotationStorageModule && window.annotationStorageModule.savedDataLayers) {
        const index = window.annotationStorageModule.savedDataLayers.findIndex(l => l.id === layerId);
        if (index >= 0) {
            window.annotationStorageModule.savedDataLayers.splice(index, 1);
            
            // Remove from map
            if (window.layerManagerModule && window.layerManagerModule.removeDataLayer) {
                window.layerManagerModule.removeDataLayer(layerId);
            }
            
            // Save to localStorage
            if (window.annotationStorageModule.saveDataLayers) {
                window.annotationStorageModule.saveDataLayers();
            }
            
            if (window.dataSelectionModule) {
                window.dataSelectionModule.selectedDataIds.delete(layerId);
                window.dataSelectionModule.updateBulkActionsVisibility();
            }
            
            refreshDataWindow();
            
            // Update layer control
            if (window.layerManagerModule && window.layerManagerModule.updateLayerControlOverlays) {
                window.layerManagerModule.updateLayerControlOverlays();
            }
        }
    }
}

// Public delete function with confirmation (for single-item deletes)
async function deleteDataLayer(layerId) {
    const windowModule = window.dataWindowModule;
    if (window.orgDataPermissionsModule && !window.orgDataPermissionsModule.canDeleteOrgData()) {
        await appAlert('You do not have permission to delete data in this organization.');
        return;
    }
    if (windowModule) {
        windowModule.isDeleting = true;
    }
    
    if (!(await appConfirm('Are you sure you want to delete this data layer? This cannot be undone.'))) {
        if (windowModule) {
            windowModule.isDeleting = false;
        }
        return;
    }
    
    deleteDataLayerInternal(layerId);
    
    // Reset flag after a short delay to allow UI to update
    setTimeout(() => {
        if (windowModule) {
            windowModule.isDeleting = false;
        }
    }, 100);
    
    // Keep the data window open after deletion
    // (window stays open - no closeDataWindow() call)
}

/**
 * Fly to a favorited aerial map extent and load the orthophoto tile layer.
 * @param {object} map Aerial map object from `savedAerialMaps`
 * @param {{ maxZoom?: number, updateUrl?: boolean, silentLoad?: boolean }} [opts]
 */
function openAerialFavoriteOnMapView(map, opts) {
    if (!map || !window.map) {
        return false;
    }
    const updateUrl = !opts || opts.updateUrl !== false;
    const silentLoad = !opts || opts.silentLoad !== false;
    let bounds = null;
    if (map.boundingBox && map.boundingBox.coordinates) {
        const coords = map.boundingBox.coordinates[0];
        bounds = L.latLngBounds(coords.map((c) => [c[1], c[0]]));
    }
    const fit =
        window.aerialMapsModule && typeof window.aerialMapsModule.fitMapToAerialFootprint === 'function'
            ? window.aerialMapsModule.fitMapToAerialFootprint
            : null;
    if (!fit || !fit(bounds)) {
        if (!bounds || !bounds.isValid()) {
            return false;
        }
        let target = null;
        try {
            if (typeof window.map._getBoundsCenterZoom === 'function') {
                target = window.map._getBoundsCenterZoom(bounds, { padding: [50, 50] });
            }
        } catch (_e) {
            /* ignore */
        }
        const panAnim = { animate: true, duration: 0.5 };
        if (target && target.center && Number.isFinite(target.zoom) && target.zoom >= 16) {
            window.map.setView(target.center, target.zoom, panAnim);
        } else {
            window.map.setView(bounds.getCenter(), 16, panAnim);
        }
    }
    if (updateUrl) {
        try {
            const u = new URL(window.location.href);
            u.searchParams.set('aerialMap', String(map.id));
            window.history.replaceState({}, '', u);
        } catch (_) {
            /* ignore */
        }
    }
    if (window.aerialMapsModule && window.aerialMapsModule.loadAerialMapOnMap) {
        void window.aerialMapsModule.loadAerialMapOnMap(map, { skipFitBounds: true, silent: silentLoad });
    }
    return true;
}

// Fly map view to a favorited aerial map extent (Manage Data → Aerial Maps)
function flyToAerialMapFavorite(mapId) {
    const id = typeof mapId === 'string' ? parseInt(mapId, 10) : mapId;
    const map =
        (window.aerialMapsModule?.findAerialMapById && window.aerialMapsModule.findAerialMapById(id)) ||
        (window.aerialMapsModule?.savedAerialMaps || []).find((m) => m.id === id || String(m.id) === String(mapId));
    if (!map || !map.boundingBox || !map.boundingBox.coordinates || !window.map) {
        void appAlert('Aerial map footprint not available.');
        return;
    }
    if (!openAerialFavoriteOnMapView(map, { updateUrl: true, silentLoad: true })) {
        void appAlert('Aerial map footprint not available.');
    }
}

/**
 * `flyToAerialMapFavorite` writes `?aerialMap=<id>`. On full page load, `app.js` runs
 * `loadSavedAerialMaps` when that param is present, then this so the map can resolve the id
 * and fly to the footprint / load that orthophoto.
 */
function applyAerialMapQueryFromUrl() {
    let raw;
    try {
        raw = new URLSearchParams(window.location.search).get('aerialMap');
    } catch (_) {
        return;
    }
    if (raw == null || String(raw).trim() === '') return;
    const id = parseInt(String(raw), 10);
    if (!Number.isFinite(id) || id <= 0) return;

    const maps = window.aerialMapsModule?.savedAerialMaps || [];
    const map = maps.find((m) => m.id === id);
    if (!map || !window.map) return;

    if (!map.boundingBox || !map.boundingBox.coordinates) {
        if (window.appAlert) void appAlert('This aerial link could not be opened (footprint not available).');
        return;
    }
    openAerialFavoriteOnMapView(map, { updateUrl: false, silentLoad: true });
}

function startDataHubAerialBboxDraw() {
    const dataWin = document.getElementById('dataWindow');
    const wasOpen =
        dataWin &&
        (dataWin.classList.contains('show') ||
            (dataWin.style.display && dataWin.style.display !== 'none'));
    if (window.aerialMapsModule?.startAccessibleAerialBboxDraw) {
        window.aerialMapsModule.startAccessibleAerialBboxDraw(!!wasOpen);
    }
}

function clearDataHubAerialSearchArea() {
    if (window.aerialMapsModule?.clearAccessibleAerialSearchArea) {
        window.aerialMapsModule.clearAccessibleAerialSearchArea();
    }
}

// Load aerial imagery on the map (optional; favorites list uses fly-to by default)
async function loadAerialMap(mapId) {
    const id = typeof mapId === 'string' ? parseInt(mapId, 10) : mapId;
    const map =
        (window.aerialMapsModule?.findAerialMapById && window.aerialMapsModule.findAerialMapById(id)) ||
        (window.aerialMapsModule?.savedAerialMaps || []).find((m) => m.id === id || m.id === mapId);
    if (!map) {
        await appAlert('Aerial map not found!');
        return;
    }
    if (window.aerialMapsModule && window.aerialMapsModule.loadAerialMapOnMap) {
        await window.aerialMapsModule.loadAerialMapOnMap(map);
    }
}

// View aerial map
async function viewAerialMap(mapId) {
    // Convert to number if it's a string
    const id = typeof mapId === 'string' ? parseInt(mapId) : mapId;
    const map =
        (window.aerialMapsModule?.findAerialMapById && window.aerialMapsModule.findAerialMapById(id)) ||
        (window.aerialMapsModule?.savedAerialMaps || []).find((m) => m.id === id || m.id === mapId);
    
    if (!map) {
        await appAlert('Aerial map not found!');
        return;
    }
    
    const createdDate = window.formatRecordedDateTime(map.createdAt);
    
    const bboxInfo = map.boundingBox ? 
        `Bounding Box: Available\nMin: [${map.boundingBox.coordinates[0][0][0]}, ${map.boundingBox.coordinates[0][0][1]}]\nMax: [${map.boundingBox.coordinates[0][2][0]}, ${map.boundingBox.coordinates[0][2][1]}]` : 
        'Bounding Box: Not available';
    
    await appAlert(`Aerial Map: ${map.name}\n\nCreated: ${createdDate}\nAdded By: ${map.addedBy || 'Unknown'}\n\n${bboxInfo}\n\nClick "Load" to load this map onto the map view.`);
}

// Remove aerial map from org favorites (Manage Data)
async function deleteAerialMap(mapId) {
    const id = typeof mapId === 'string' ? parseInt(mapId, 10) : mapId;
    const orgId = typeof window.getCurrentOrgId === 'function' ? window.getCurrentOrgId() : null;
    if (!(await appConfirm('Remove this map from your favorites?'))) return;
    try {
        await window.authModule.apiRequest(`/api/data/aerial-favorites/${id}?organizationId=${orgId}`, { method: 'DELETE' });
        await window.aerialMapsModule.loadSavedAerialMaps();
        refreshDataWindow();
    } catch (error) {
        await appAlert(error.message || 'Failed to remove favorite');
    }
}

// Open add aerial map modal
async function openAddAerialMapModal() {
    const url = await appPrompt(
        'Enter the GCP bucket URL for the TMS tileset (tilemapresource.xml), e.g.:\nhttps://storage.googleapis.com/nodeodm-outputs-v1/outputs/Daniel_Test_A2/orthophoto_tiles/tilemapresource.xml',
        '',
        { title: 'Add aerial map', multiline: true }
    );
    if (!url || !url.trim()) return;
    // Aerial maps are linked to the currently selected organization
    const orgId = typeof window.getCurrentOrgId === 'function' ? window.getCurrentOrgId() : null;
    addAerialMap(url.trim(), orgId);
}

// Add aerial map
async function addAerialMap(url, organizationId) {
    try {
        await window.aerialMapsModule.addAerialMap(url, organizationId);
        
        // Ensure we're on the aerial maps view and refresh the table
        if (window.dataWindowModule) {
            const currentView = window.dataWindowModule.currentDataView;
            // If not on aerial maps view, switch to it
            if (currentView !== 'aerialmaps') {
                if (window.switchDataView) {
                    window.switchDataView('aerialmaps');
                } else if (window.dataWindowModule.switchDataView) {
                    window.dataWindowModule.switchDataView('aerialmaps');
                }
            } else if (window.aerialMapsModule && window.aerialMapsModule.loadSavedAerialMaps) {
                await window.aerialMapsModule.loadSavedAerialMaps();
            }
        }
        
        // Force refresh the data window to show the new map
        setTimeout(() => {
            refreshDataWindow();
        }, 100);
        
        await appAlert('Aerial map added successfully!');
    } catch (error) {
        console.error('Error adding aerial map:', error);
        await appAlert('Error adding aerial map: ' + error.message);
    }
}

// Make functions globally available for HTML onclick handlers
window.filterDataTable = filterDataTable;
window.clearDataHubSearch = clearDataHubSearch;
window.openDataSearchModal = openDataSearchModal;
window.closeDataSearchModal = closeDataSearchModal;
window.onDataSearchModalInput = onDataSearchModalInput;
window.clearDataSearchModal = clearDataSearchModal;
window.viewDataItem = viewDataItem;
window.deleteDataItem = deleteDataItem;
window.loadDataLayer = loadDataLayer;
window.bulkLoadSelectedLayers = bulkLoadSelectedLayers;
window.viewDataLayer = viewDataLayer;
window.deleteDataLayer = deleteDataLayer;
window.flyToAerialMapFavorite = flyToAerialMapFavorite;
window.startDataHubAerialBboxDraw = startDataHubAerialBboxDraw;
window.clearDataHubAerialSearchArea = clearDataHubAerialSearchArea;
window.applyAerialMapQueryFromUrl = applyAerialMapQueryFromUrl;
window.loadAerialMap = loadAerialMap;
window.viewAerialMap = viewAerialMap;
window.deleteAerialMap = deleteAerialMap;
window.openAddAerialMapModal = openAddAerialMapModal;

// Export for use in other modules
window.dataModule = {
    initDataWindow,
    refreshDataWindow,
    filterDataTable,
    viewDataItem,
    deleteDataItem,
    loadDataLayer,
    loadDataLayerSilent,
    bulkLoadSelectedLayers,
    viewDataLayer,
    deleteDataLayer,
    deleteDataLayerInternal, // Expose for bulk operations
    flyToAerialMapFavorite,
    applyAerialMapQueryFromUrl,
    loadAerialMap,
    viewAerialMap,
    deleteAerialMap,
    openAddAerialMapModal,
};
