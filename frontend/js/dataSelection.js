// Data Selection module - Selection management and bulk actions

// Selection state
let selectedDataIds = new Set();

function clearSelection() {
    selectedDataIds.clear();
    const checkboxes = document.querySelectorAll(
        '.data-table-checkbox input[type="checkbox"][data-action], .photos-gallery-card__select input[type="checkbox"][data-action]'
    );
    checkboxes.forEach(function (checkbox) {
        checkbox.checked = false;
        checkbox.indeterminate = false;
    });
    document.querySelectorAll('.photos-gallery-card.is-selected').forEach(function (card) {
        card.classList.remove('is-selected');
    });
    syncSelectAllDataCheckbox();
    updateBulkActionsVisibility();
    if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
}

function clearDataHubSelection() {
    clearSelection();
}

/** Item ids visible after search/filter (and ticket/doc query filters), matching table renderers. */
function getFilteredManageDataViewItemIds() {
    const windowModule = window.dataWindowModule;
    if (!windowModule) return [];
    const currentView = windowModule.currentDataView;
    const filt = window.tableFilteringModule;
    const searchTerm = filt?.getSearchTerm() || '';

    if (currentView === 'annotations') {
        const annotations = window.annotationStorageModule?.annotations || [];
        let items = filt?.filterAnnotations(annotations, searchTerm) || annotations;
        if (window.dataHubFiltersModule?.applyFilters) {
            items = window.dataHubFiltersModule.applyFilters('annotations', items);
        }
        return items.map((a) => a.id);
    }
    if (currentView === 'layers') {
        const layers = window.annotationStorageModule?.savedDataLayers || [];
        let items = filt?.filterDataLayers(layers, searchTerm) || layers;
        if (window.dataHubFiltersModule?.applyFilters) {
            items = window.dataHubFiltersModule.applyFilters('layers', items);
        }
        return items.map((l) => l.id);
    }
    if (currentView === 'photos') {
        const photos = window.photosModule?.savedPhotos || [];
        let items = filt?.filterPhotos(photos, searchTerm) || photos;
        if (window.dataHubFiltersModule?.applyFilters) {
            items = window.dataHubFiltersModule.applyFilters('photos', items);
        }
        if (window.photosBatchesPanelModule?.applyActiveBatchFilter) {
            items = window.photosBatchesPanelModule.applyActiveBatchFilter(items);
        }
        return items.map((p) => p.id);
    }
    if (currentView === 'documents') {
        let documents = window.documentsModule?.savedDocuments || [];
        if (window.documentQueryResults && window.documentQueryResults.length > 0) {
            const queryResultIds = new Set(window.documentQueryResults);
            documents = documents.filter((doc) => queryResultIds.has(doc.id));
        }
        let items = filt?.filterDocuments(documents, searchTerm) || documents;
        if (window.dataHubFiltersModule?.applyFilters) {
            items = window.dataHubFiltersModule.applyFilters('documents', items);
        }
        return items.map((d) => d.id);
    }
    if (currentView === 'aerialmaps') {
        const maps = window.aerialMapsModule?.accessibleAerialMaps || [];
        const searchTerm = filt?.getSearchTerm() || '';
        const filtered = searchTerm
            ? maps.filter((map) => (map.name || '').toLowerCase().includes(searchTerm.toLowerCase()))
            : maps;
        return filtered.map((m) => m.id);
    }
    if (currentView === 'events') {
        let reports = [];
        if (window.reportedEventsStore && window.reportedEventsStore.getReportsForCurrentOrg) {
            reports = window.reportedEventsStore.getReportsForCurrentOrg();
        }
        if (!reports.length) {
            const allReports = JSON.parse(localStorage.getItem('dirtReports') || '[]');
            const user = window.authModule?.getCurrentUser();
            const currentOrgId = user?.organizationId;
            reports = currentOrgId ? allReports.filter((r) => r.organizationId === currentOrgId) : allReports;
        }
        const filterTicketId = windowModule.filterTicketId;
        const filterTicketNumber = windowModule.filterTicketNumber;
        if (
            (filterTicketId != null && filterTicketId !== '') ||
            (filterTicketNumber != null && filterTicketNumber !== '')
        ) {
            reports = reports.filter((report) => {
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
        let filteredReports = filt?.filterReportedEvents(reports, searchTerm) || reports;
        if (window.dataHubFiltersModule?.applyFilters) {
            filteredReports = window.dataHubFiltersModule.applyFilters('events', filteredReports);
        }
        const sortState = window.tableSortingModule?.getSortStateForView
            ? window.tableSortingModule.getSortStateForView('events')
            : window.tableSortingModule?.getSortState() || { column: null, direction: 'asc' };
        const sortedReports = sortState.column && window.tableSortingModule?.sortData
            ? window.tableSortingModule.sortData(filteredReports, sortState.column, sortState.direction, 'events')
            : filteredReports;
        return sortedReports.map((r, i) => String(r.id || `event-${i}`));
    }
    return [];
}

function getManageDataViewItemIds() {
    return getFilteredManageDataViewItemIds();
}

function selectionHasId(id) {
    if (id == null) return false;
    return selectedDataIds.has(id) || selectedDataIds.has(String(id));
}

function selectionAddId(id) {
    if (id == null) return;
    selectedDataIds.add(String(id));
}

function selectionDeleteId(id) {
    if (id == null) return;
    selectedDataIds.delete(id);
    selectedDataIds.delete(String(id));
}

function syncSelectAllDataCheckbox() {
    const selectAllCheckbox = document.getElementById('selectAllData');
    if (!selectAllCheckbox) return;
    const windowModule = window.dataWindowModule;
    const currentView = windowModule?.currentDataView;
    let ids;
    if (currentView === 'photos' && window.dataHubPaginationModule?.getPhotosPageItemIds) {
        ids = window.dataHubPaginationModule.getPhotosPageItemIds();
    } else {
        ids = getManageDataViewItemIds();
    }
    const total = ids.length;
    const selected = ids.filter((id) => selectionHasId(id)).length;
    if (total === 0 || selected === 0) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
    } else if (selected === total) {
        selectAllCheckbox.checked = true;
        selectAllCheckbox.indeterminate = false;
    } else {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = true;
    }
}

function toggleSelectAllData() {
    const windowModule = window.dataWindowModule;
    if (!windowModule) return;

    const currentView = windowModule.currentDataView;
    const selectAllCheckbox = document.getElementById('selectAllData');
    const isChecked = selectAllCheckbox?.checked || false;
    if (selectAllCheckbox) selectAllCheckbox.indeterminate = false;

    if (currentView === 'photos' && window.dataHubPaginationModule?.getPhotosPageItemIds) {
        const pageIds = window.dataHubPaginationModule.getPhotosPageItemIds();
        if (isChecked) {
            pageIds.forEach((id) => selectionAddId(id));
        } else {
            pageIds.forEach((id) => selectionDeleteId(id));
        }
    } else {
        selectedDataIds.clear();
        if (isChecked) {
            getFilteredManageDataViewItemIds().forEach((id) => selectedDataIds.add(id));
        }
    }

    // Update checkboxes in table
    const checkboxes = document.querySelectorAll('.data-table-checkbox input[type="checkbox"][data-action], .photos-gallery-card__select input[type="checkbox"][data-action]');
    checkboxes.forEach((checkbox) => {
        const id = checkbox.getAttribute('data-id');
        if (currentView === 'photos' && id) {
            checkbox.checked = selectionHasId(id);
        } else {
            checkbox.checked = isChecked;
        }
        checkbox.indeterminate = false;
    });

    syncSelectAllDataCheckbox();
    updateBulkActionsVisibility();

    if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
}

function toggleGroupSelection(view, groupId) {
    const groupsModule = window.dataWindowGroupsModule;
    if (!groupsModule) return;
    const groups = groupsModule.getGroups(view);
    const group = groups.find(g => g.id === groupId);
    if (!group || !group.itemIds || group.itemIds.length === 0) return;
    const allSelected = group.itemIds.every(id => selectedDataIds.has(id));
    if (allSelected) {
        group.itemIds.forEach(id => selectedDataIds.delete(id));
    } else {
        group.itemIds.forEach(id => selectedDataIds.add(id));
    }
    syncSelectAllDataCheckbox();
    updateBulkActionsVisibility();
    if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
}

function toggleDataSelection(id) {
    if (selectionHasId(id)) {
        selectionDeleteId(id);
    } else {
        selectionAddId(id);
    }

    const card = document.querySelector(`.photos-gallery-card[data-id="${CSS.escape ? CSS.escape(String(id)) : String(id)}"]`);
    if (card) {
        card.classList.toggle('is-selected', selectionHasId(id));
    }

    syncSelectAllDataCheckbox();
    updateBulkActionsVisibility();
}

// Update bulk actions visibility based on selection
function updateBulkActionsVisibility() {
    const bulkActions = document.getElementById('dataBulkActions');
    if (!bulkActions) return;

    const currentView = window.dataWindowModule?.currentDataView;
    const exportBtn = document.getElementById('exportSelectedButton');
    const exportSupported = currentView === 'annotations'
        || currentView === 'layers'
        || currentView === 'photos';
    if (exportBtn) {
        exportBtn.style.display = exportSupported ? '' : 'none';
    }
    
    const loadLayersBtn = document.getElementById('loadSelectedLayersButton');
    if (loadLayersBtn) {
        loadLayersBtn.style.display =
            currentView === 'layers' && selectedDataIds.size > 0 ? '' : 'none';
    }

    const bulkMakePublicBtn = document.getElementById('bulkMakePublicButton');
    const bulkMakePrivateBtn = document.getElementById('bulkMakePrivateButton');
    const canBulkPublic =
        selectedDataIds.size > 0 &&
        (currentView === 'layers' || currentView === 'photos') &&
        !(typeof window.isCurrentOrgPublicCatalogViewer === 'function' && window.isCurrentOrgPublicCatalogViewer()) &&
        ((currentView === 'layers' &&
            window.annotationStorageModule?.canAdminLayerPublicFlag?.()) ||
            (currentView === 'photos' && window.photosModule?.canAdminPhotoPublicFlag?.()));
    if (bulkMakePublicBtn) bulkMakePublicBtn.style.display = canBulkPublic ? '' : 'none';
    if (bulkMakePrivateBtn) bulkMakePrivateBtn.style.display = canBulkPublic ? '' : 'none';

    if (selectedDataIds.size > 0) {
        bulkActions.style.display = 'flex';
        const groupBtn = document.getElementById('groupSelectedButton');
        if (groupBtn) {
            groupBtn.style.display =
                currentView !== 'photos' && selectedDataIds.size >= 2 ? 'block' : 'none';
        }
        const saveBatchBtn = document.getElementById('savePhotoBatchButton');
        if (saveBatchBtn) {
            saveBatchBtn.style.display = currentView === 'photos' && selectedDataIds.size >= 1 ? '' : 'none';
        }
        const bulkAssociateBtn = document.getElementById('bulkAssociatePhotosButton');
        if (bulkAssociateBtn) {
            const showAssociate =
                currentView === 'photos' &&
                typeof window.selectionHasNoGpsPhotosForAssociate === 'function' &&
                window.selectionHasNoGpsPhotosForAssociate();
            bulkAssociateBtn.style.display = showAssociate ? '' : 'none';
        }
        const deleteBtns = bulkActions.querySelectorAll('button[onclick*="bulkDeleteSelected"]');
        deleteBtns.forEach((btn) => {
            const canDelete =
                currentView !== 'aerialmaps' &&
                (!window.orgDataPermissionsModule || window.orgDataPermissionsModule.canDeleteOrgData());
            btn.style.display = canDelete ? '' : 'none';
        });
    } else {
        bulkActions.style.display = 'none';
        const saveBatchBtn = document.getElementById('savePhotoBatchButton');
        if (saveBatchBtn) saveBatchBtn.style.display = 'none';
        const bulkAssociateBtn = document.getElementById('bulkAssociatePhotosButton');
        if (bulkAssociateBtn) bulkAssociateBtn.style.display = 'none';
    }
}

// Create a group from currently selected items (2+ required)
async function createGroupFromSelection() {
    const windowModule = window.dataWindowModule;
    const groupsModule = window.dataWindowGroupsModule;
    if (!windowModule || !groupsModule || selectedDataIds.size < 2) {
        if (selectedDataIds.size < 2) await appAlert('Select at least 2 items to group.');
        return;
    }
    const view = windowModule.currentDataView;
    const name = await appPrompt('Group name:', 'New Group', { title: 'New group' });
    if (name == null) return;
    const itemIds = Array.from(selectedDataIds);
    groupsModule.createGroup(view, (name && name.trim()) || 'New Group', itemIds);
    selectedDataIds.clear();
    updateBulkActionsVisibility();
    if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
}

// Bulk delete selected items
async function bulkDeleteSelected() {
    const windowModule = window.dataWindowModule;
    if (!windowModule) return;
    if (window.orgDataPermissionsModule && !window.orgDataPermissionsModule.canDeleteOrgData()) {
        await appAlert('You do not have permission to delete data in this organization.');
        return;
    }
    
    if (selectedDataIds.size === 0) {
        await appAlert('No items selected.');
        return;
    }
    
    // Set flag to prevent window from closing during delete
    windowModule.isDeleting = true;
    
    const currentView = windowModule.currentDataView;
    if (currentView === 'aerialmaps') {
        windowModule.isDeleting = false;
        return;
    }
    const count = selectedDataIds.size;
    const itemType =
        currentView === 'annotations'
            ? 'annotation'
            : currentView === 'layers'
              ? 'data layer'
              : currentView === 'photos'
                ? 'photo'
                : currentView === 'documents'
                  ? 'document'
                  : currentView === 'events'
                    ? 'event report'
                    : 'item';
    
    const confirmMsg = `Are you sure you want to delete ${count} ${itemType}? This cannot be undone.`;
    if (!(await appConfirm(confirmMsg))) {
        windowModule.isDeleting = false;
        return;
    }

    const busyLabel =
        currentView === 'photos'
            ? 'Deleting ' + count + ' photo' + (count === 1 ? '' : 's') + '…'
            : currentView === 'documents'
              ? 'Deleting ' + count + ' document' + (count === 1 ? '' : 's') + '…'
              : 'Deleting ' + count + ' item' + (count === 1 ? '' : 's') + '…';
    if (window.dataWindowModule?.setDataHubBusy) {
        window.dataWindowModule.setDataHubBusy(true, busyLabel);
    }

    try {
    if (currentView === 'annotations') {
        // Delete selected annotations using internal function (no confirmation)
        const idsToDelete = Array.from(selectedDataIds);
        
        idsToDelete.forEach(id => {
            // Use internal delete function from annotations module if available
            if (window.annotationStorageModule && window.annotationStorageModule.deleteAnnotationInternal) {
                window.annotationStorageModule.deleteAnnotationInternal(id);
            }
        });
        
        // Refresh annotations display
        if (window.layerManagerModule && window.layerManagerModule.updateLayerControlOverlays) {
            window.layerManagerModule.updateLayerControlOverlays();
        }
        
        selectedDataIds.clear();
        updateBulkActionsVisibility();
        if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
            window.dataTableRendererModule.renderDataTable();
        }
    } else if (currentView === 'layers') {
        // Delete selected data layers using internal function (no confirmation)
        const idsToDelete = Array.from(selectedDataIds);
        
        idsToDelete.forEach(id => {
            if (window.dataModule && window.dataModule.deleteDataLayerInternal) {
                window.dataModule.deleteDataLayerInternal(id);
            }
        });
        
        selectedDataIds.clear();
        updateBulkActionsVisibility();
        if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
            window.dataTableRendererModule.renderDataTable();
        }
    } else if (currentView === 'photos') {
        const idsToDelete = Array.from(selectedDataIds);
        if (window.deleteSelectedPhotos) {
            await window.deleteSelectedPhotos(idsToDelete, { skipConfirm: true });
        }
        selectedDataIds.clear();
        updateBulkActionsVisibility();
    } else if (currentView === 'documents') {
        const idsToDelete = Array.from(selectedDataIds);
        if (window.documentsModule?.deleteDocument) {
            for (const docId of idsToDelete) {
                try {
                    await window.documentsModule.deleteDocument(docId);
                } catch (err) {
                    console.error('Error deleting document:', err);
                }
            }
        }
        selectedDataIds.clear();
        updateBulkActionsVisibility();
        if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
            window.dataTableRendererModule.renderDataTable();
        }
    } else if (currentView === 'events') {
        const idsToDelete = Array.from(selectedDataIds);
        const originalAppConfirm = window.appConfirm;
        window.appConfirm = async function () {
            return true;
        };
        try {
            for (const eventId of idsToDelete) {
                if (window.deleteEvent) {
                    try {
                        await window.deleteEvent(eventId);
                    } catch (err) {
                        console.error('Error deleting event:', err);
                    }
                }
            }
        } finally {
            window.appConfirm = originalAppConfirm;
        }
        selectedDataIds.clear();
        updateBulkActionsVisibility();
        if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
            window.dataTableRendererModule.renderDataTable();
        }
    } else {
        windowModule.isDeleting = false;
        return;
    }
    } finally {
        if (window.dataWindowModule?.setDataHubBusy) {
            window.dataWindowModule.setDataHubBusy(false);
        }
    }

    // Reset flag after a short delay to allow UI to update
    setTimeout(() => {
        windowModule.isDeleting = false;
    }, 200);

    const doneMsg = `Successfully deleted ${count} ${itemType}${count === 1 ? '' : 's'}.`;
    await appAlert(doneMsg);
    
    // Keep the data window open after bulk deletion
    // (window stays open - no closeDataWindow() call)
}

// Export for use in other modules
window.dataSelectionModule = {
    get selectedDataIds() { return selectedDataIds; },
    clearSelection,
    clearDataHubSelection,
    toggleSelectAllData,
    toggleDataSelection,
    syncSelectAllDataCheckbox,
    updateBulkActionsVisibility,
    bulkDeleteSelected
};

// Make functions globally available for HTML onclick handlers
window.toggleSelectAllData = toggleSelectAllData;
window.toggleDataSelection = toggleDataSelection;
window.clearDataHubSelection = clearDataHubSelection;
window.updateBulkActionsVisibility = updateBulkActionsVisibility;
window.bulkDeleteSelected = bulkDeleteSelected;
window.createGroupFromSelection = createGroupFromSelection;
window.toggleGroupSelection = toggleGroupSelection;

