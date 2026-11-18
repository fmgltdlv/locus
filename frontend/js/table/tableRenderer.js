// Main table renderer orchestrator - dispatches to specific renderers

// Render main data table (dispatches to specific renderers)
function renderDataTable() {
    const tbody = document.getElementById('dataTableBody');
    const emptyState = document.getElementById('dataTableEmpty');
    
    if (!tbody) return;
    
    const windowModule = window.dataWindowModule;
    if (!windowModule) return;
    
    const currentView = windowModule.currentDataView;
    const legacyPhotoPager = document.getElementById('photoDataPagination');
    if (legacyPhotoPager) legacyPhotoPager.remove();
    
    // Update sort indicators before rendering
    if (window.tableSortingModule && window.tableSortingModule.updateSortIndicators) {
        window.tableSortingModule.updateSortIndicators();
    }
    
    // Check which view we're showing
    if (currentView === 'layers') {
        if (window.layersTableRenderer && window.layersTableRenderer.renderDataLayersTable) {
            window.layersTableRenderer.renderDataLayersTable(tbody, emptyState);
        }
    } else if (currentView === 'photos') {
        if (window.photosTableRenderer && window.photosTableRenderer.renderPhotosTable) {
            window.photosTableRenderer.renderPhotosTable(tbody, emptyState);
        }
    } else if (currentView === 'documents') {
        if (window.documentsTableRenderer && window.documentsTableRenderer.renderDocumentsTable) {
            window.documentsTableRenderer.renderDocumentsTable(tbody, emptyState);
        }
    } else if (currentView === 'aerialmaps') {
        if (window.aerialMapsTableRenderer && window.aerialMapsTableRenderer.renderAerialMapsTable) {
            window.aerialMapsTableRenderer.renderAerialMapsTable(tbody, emptyState);
        }
    } else if (currentView === 'events') {
        if (window.eventsTableRenderer && window.eventsTableRenderer.renderReportedEventsTable) {
            window.eventsTableRenderer.renderReportedEventsTable(tbody, emptyState);
        }
    } else {
        // Default to annotations
        if (window.annotationsTableRenderer && window.annotationsTableRenderer.renderAnnotationsTable) {
            window.annotationsTableRenderer.renderAnnotationsTable(tbody, emptyState);
        }
    }
    if (window.syncManageDataTableThead) {
        window.syncManageDataTableThead();
    }
    if (window.syncDataFilterContextBanner) {
        window.syncDataFilterContextBanner();
    }
    if (window.dataSelectionModule?.syncSelectAllDataCheckbox) {
        window.dataSelectionModule.syncSelectAllDataCheckbox();
    }
}

// Export for use in other modules
window.dataTableRendererModule = {
    renderDataTable,
    // Re-export renderers for backward compatibility
    renderAnnotationsTable: window.annotationsTableRenderer?.renderAnnotationsTable,
    renderDataLayersTable: window.layersTableRenderer?.renderDataLayersTable,
    renderPhotosTable: window.photosTableRenderer?.renderPhotosTable,
    renderDocumentsTable: window.documentsTableRenderer?.renderDocumentsTable,
    renderAerialMapsTable: window.aerialMapsTableRenderer?.renderAerialMapsTable,
    renderReportedEventsTable: window.eventsTableRenderer?.renderReportedEventsTable,
    // Re-export utilities
    formatFileSize: window.tableUtilsModule?.formatFileSize,
    calculateDataUrlSize: window.tableUtilsModule?.calculateDataUrlSize,
    getUtilityTypeDisplay: window.tableUtilsModule?.getUtilityTypeDisplay,
    getGpsSourceDisplay: window.tableUtilsModule?.getGpsSourceDisplay,
    // Re-export actions
    viewPhoto: window.tableActionsModule?.viewPhoto,
    zoomToPhoto: window.tableActionsModule?.zoomToPhoto,
    deletePhoto: window.tableActionsModule?.deletePhoto,
    toggleBatchSelection: window.tableActionsModule?.toggleBatchSelection,
    zoomToBatch: window.tableActionsModule?.zoomToBatch,
    deleteBatch: window.tableActionsModule?.deleteBatch,
    editDataItemName: window.tableActionsModule?.editDataItemName,
    updateDataLayerUtilityType: window.tableActionsModule?.updateDataLayerUtilityType,
    viewDocument: window.tableActionsModule?.viewDocument,
    deleteDocument: window.tableActionsModule?.deleteDocument,
    tagPhotoLocation: window.tableActionsModule?.tagPhotoLocation,
    restoreAnnotations: window.tableActionsModule?.restoreAnnotations,
    toggleBatchCollapse: window.tableActionsModule?.toggleBatchCollapse,
    // Re-export queries
    queryDataForLayer: window.tableQueriesModule?.queryDataForLayer,
    queryAllDataInTab: window.tableQueriesModule?.queryAllDataInTab,
    processDataQueryForTab: window.tableQueriesModule?.processDataQueryForTab,
    queryAnnotationsInPolygon: window.tableQueriesModule?.queryAnnotationsInPolygon,
    queryDataLayersInPolygon: window.tableQueriesModule?.queryDataLayersInPolygon,
    queryPhotosInPolygon: window.tableQueriesModule?.queryPhotosInPolygon,
    queryReportedEventsInPolygon: window.tableQueriesModule?.queryReportedEventsInPolygon,
    addTempLayerToControl: window.tableQueriesModule?.addTempLayerToControl,
    // refreshDataWindow is defined in data.js, not here, but we'll add a wrapper for compatibility
    refreshDataWindow: function() {
        if (window.refreshDataWindow) {
            window.refreshDataWindow();
        } else {
            // Fallback: just render the table
            renderDataTable();
        }
    }
};

