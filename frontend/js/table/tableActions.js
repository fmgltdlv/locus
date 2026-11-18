/**
 * tableActions.js — split from tableActions.js (Phase F4).
 * Manage-data rename/public/utility helpers + thin barrel attaching window.tableActionsModule.
 */
// Edit data item name
async function editDataItemName(id, type) {
    const windowModule = window.dataWindowModule;
    if (windowModule) {
        windowModule.isEditingName = true;
    }
    let currentName = '';
    let originalName = '';
    let itemForPerm = null;
    
    if (type === 'annotation') {
        const annotations = window.annotationStorageModule?.annotations || [];
        const item = annotations.find(a => a.id === id);
        itemForPerm = item;
        if (item) {
            currentName = item.name || item.type || 'Unnamed';
            originalName = item.originalName || currentName;
        }
    } else if (type === 'layer') {
        const layers = window.annotationStorageModule?.savedDataLayers || [];
        const item = layers.find(l => l.id === id);
        itemForPerm = item;
        if (item) {
            currentName = item.name || 'Unnamed Layer';
            originalName = item.originalName || currentName;
        }
    } else if (type === 'photo') {
        const photos = window.photosModule?.savedPhotos || [];
        const item = photos.find(p => p.id === id);
        itemForPerm = item;
        if (item) {
            currentName = item.fileName || 'Unnamed Photo';
            originalName = item.originalFileName || currentName;
        }
    } else if (type === 'document') {
        const documents = window.documentsModule?.savedDocuments || [];
        const item = documents.find(d => d.id === id);
        itemForPerm = item;
        if (item) {
            currentName = item.fileName || 'Unnamed Document';
            originalName = item.originalFileName || currentName;
        }
    } else if (type === 'aerialmap') {
        const maps = window.aerialMapsModule?.savedAerialMaps || [];
        const item = maps.find(m => m.id === id);
        itemForPerm = item;
        if (item) {
            currentName = item.name || 'Unnamed Map';
            originalName = item.originalName || item.name || currentName;
        }
    } else if (type === 'event') {
        const item = findDirtReportByStableId(id);
        itemForPerm = item;
        if (item) {
            currentName = item.name || item.ticketNumber || 'Unknown Ticket';
            originalName = item.originalName || item.ticketNumber || currentName;
        }
    }
    
    if (!currentName) return;
    if (window.orgDataPermissionsModule && !window.orgDataPermissionsModule.guardEditDataItem(type, itemForPerm)) {
        setTimeout(() => {
            if (windowModule) windowModule.isEditingName = false;
        }, 100);
        return;
    }
    
    const promptLabel = type === 'event' ? 'event' : type;
    const newName = await appPrompt(
        `Rename ${promptLabel}:\n\nCurrent name: ${currentName}\nOriginal name: ${originalName}\n\nEnter new name:`,
        currentName,
        { title: 'Rename' }
    );

    // Clear editing flag after a short delay so the prompt's OK click doesn't close the data window
    setTimeout(() => {
        if (windowModule) {
            windowModule.isEditingName = false;
        }
    }, 100);

    if (newName === null || newName.trim() === '') {
        return; // User cancelled or entered empty name
    }
    
    if (type === 'annotation') {
        const annotations = window.annotationStorageModule?.annotations || [];
        const item = annotations.find(a => a.id === id);
        if (item) {
            item.name = newName.trim();
            if (!item.originalName) {
                item.originalName = originalName;
            }
            window.annotationStorageModule.saveAnnotations();
            if (window.annotationRendererModule) {
                window.annotationRendererModule.renderAnnotations();
            }
        }
    } else if (type === 'layer') {
        const layers = window.annotationStorageModule?.savedDataLayers || [];
        const item = layers.find(l => l.id === id);
        if (item) {
            item.name = newName.trim();
            if (!item.originalName) {
                item.originalName = originalName;
            }
            window.annotationStorageModule.saveDataLayers();
        }
    } else if (type === 'photo') {
        if (window.photosModule && window.photosModule.savedPhotos) {
            const item = window.photosModule.savedPhotos.find(p => p.id === id);
            if (item) {
                item.fileName = newName.trim();
                if (!item.originalFileName) {
                    item.originalFileName = originalName;
                }
                window.photosModule.savePhotos();
            }
        }
    } else if (type === 'document') {
        if (window.documentsModule) {
            window.documentsModule.renameDocument(id, newName.trim());
        }
    } else if (type === 'aerialmap') {
        const maps = window.aerialMapsModule?.savedAerialMaps || [];
        const item = maps.find(m => m.id === id);
        if (item) {
            item.name = newName.trim();
            if (!item.originalName) {
                item.originalName = originalName;
            }
            // Note: In a full implementation, you'd want to save this to the backend
        }
    } else if (type === 'event') {
        const item = findDirtReportByStableId(id);
        if (item && window.authModule) {
            item.name = newName.trim();
            if (!item.originalName) {
                item.originalName = originalName;
            }
            let sid = parseInt(String(item.id), 10);
            if (!Number.isFinite(sid) && item.serverId != null) sid = Number(item.serverId);
            const oid =
                typeof window.getCurrentOrgId === 'function'
                    ? window.getCurrentOrgId()
                    : window.authModule.getCurrentUser().organizationId;
            try {
                if (Number.isFinite(sid)) {
                    let password = '';
                    if (item.isDraft !== true) {
                        if (typeof window.promptReportedEventEditPassword === 'function') {
                            password = await window.promptReportedEventEditPassword(
                                item,
                                'Enter your account password to rename this submitted report.'
                            );
                        } else if (typeof window.appPasswordPrompt === 'function') {
                            password = await window.appPasswordPrompt(
                                'Enter your account password to rename this submitted report.',
                                { title: 'Confirm password', confirmText: 'Continue' }
                            );
                        }
                        if (password == null) return;
                    }
                    const body = { ...item, organizationId: oid };
                    if (password) body.password = password;
                    await window.authModule.apiRequest(`data/reported-events/${sid}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                    });
                }
                if (window.reportedEventsStore) {
                    window.reportedEventsStore.invalidate();
                    await window.reportedEventsStore.ensureLoaded();
                }
            } catch (e) {
                void appAlert(e.message || 'Failed to rename event');
                return;
            }
        }
    }
    
    // Refresh table
    if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
}

async function toggleLayerPublic(layerId, isPublic, checkboxEl) {
    const storageMod = window.annotationStorageModule;
    if (!storageMod || !storageMod.setLayerPublicFlag || !layerId) return;
    try {
        await storageMod.setLayerPublicFlag(layerId, !!isPublic);
        if (window.refreshDataWindow) window.refreshDataWindow();
    } catch (err) {
        console.error('Failed to update layer public flag:', err);
        if (checkboxEl) checkboxEl.checked = !isPublic;
        if (typeof appAlert === 'function') {
            await appAlert(err.message || 'Could not update public sharing.');
        }
    }
}

async function bulkSetSelectedLayersPublic(isPublic) {
    const storageMod = window.annotationStorageModule;
    if (!storageMod?.canAdminLayerPublicFlag?.() || !storageMod.setLayerPublicFlag) return;

    const selected = window.dataSelectionModule?.selectedDataIds;
    if (!selected || selected.size === 0) {
        if (typeof appAlert === 'function') await appAlert('No items selected.');
        return;
    }

    const layers = window.annotationStorageModule?.savedDataLayers || [];
    const ids = Array.from(selected);
    const eligible = [];
    let skippedShared = 0;
    let skippedMissing = 0;

    ids.forEach((id) => {
        const layer = layers.find((l) => String(l.id) === String(id));
        if (!layer) {
            skippedMissing += 1;
            return;
        }
        if (layer.shared) {
            skippedShared += 1;
            return;
        }
        eligible.push(layer);
    });

    if (eligible.length === 0) {
        const parts = [];
        if (skippedShared) parts.push(`${skippedShared} shared`);
        if (skippedMissing) parts.push(`${skippedMissing} not found`);
        if (typeof appAlert === 'function') {
            await appAlert(`No eligible layers to update.${parts.length ? ` Skipped: ${parts.join(', ')}.` : ''}`);
        }
        return;
    }

    const action = isPublic ? 'public' : 'private';
    if (typeof appConfirm === 'function') {
        const ok = await appConfirm(`Make ${eligible.length} selected layer(s) ${action}?`);
        if (!ok) return;
    }

    let updated = 0;
    let failed = 0;
    for (const layer of eligible) {
        try {
            await storageMod.setLayerPublicFlag(layer.id, !!isPublic);
            layer.isPublic = !!isPublic;
            updated += 1;
        } catch (err) {
            failed += 1;
            console.error('Failed to update layer public flag:', err);
        }
    }

    if (window.refreshDataWindow) window.refreshDataWindow();

    const summaryParts = [`${updated} updated`];
    const skippedTotal = skippedShared + skippedMissing;
    if (skippedTotal) summaryParts.push(`${skippedTotal} skipped`);
    if (failed) summaryParts.push(`${failed} failed`);
    if (typeof appAlert === 'function') {
        await appAlert(`Bulk layer update complete: ${summaryParts.join(', ')}.`);
    }
}

async function bulkMakeSelectedPublic() {
    const view = window.dataWindowModule?.currentDataView;
    if (view === 'layers') await bulkSetSelectedLayersPublic(true);
    else if (view === 'photos') await bulkSetSelectedPhotosPublic(true);
}

async function bulkMakeSelectedPrivate() {
    const view = window.dataWindowModule?.currentDataView;
    if (view === 'layers') await bulkSetSelectedLayersPublic(false);
    else if (view === 'photos') await bulkSetSelectedPhotosPublic(false);
}

// Update data layer utility type
function updateDataLayerUtilityType(layerId, utilityType) {
    const layers = window.annotationStorageModule?.savedDataLayers || [];
    const layer = layers.find(l => l.id === layerId);
    if (!layer) return;
    const various = window.utilityTypesModule?.DATA_LAYER_UTILITY_VARIOUS || 'Various';
    if (layer.utilityType === various) return;

    layer.utilityType = utilityType;
    const utilityTypesModule = window.utilityTypesModule;
    const ft = window.featureTypeLibraryModule;
    const orgId = typeof window.getCurrentOrgId === 'function' ? window.getCurrentOrgId() : null;
    const lib = ft && typeof ft.getAnnotationFeatureTypeLibraryForOrgId === 'function'
        ? ft.getAnnotationFeatureTypeLibraryForOrgId(orgId)
        : [];
    const resolved = ft && typeof ft.resolveFeatureTypeStyle === 'function'
        ? ft.resolveFeatureTypeStyle(utilityType, lib)
        : null;
    const newColor = resolved && resolved.color
        ? resolved.color
        : (utilityTypesModule && typeof utilityTypesModule.getColorFromUtilityType === 'function'
            ? utilityTypesModule.getColorFromUtilityType(utilityType)
            : 'var(--app-accent)');
    const linePattern = resolved && resolved.linePattern ? resolved.linePattern : 'solid';

    if (layer.annotations) {
        layer.annotations.forEach(annotation => {
            annotation.color = newColor;
            annotation.utilityType = utilityType;
            if (annotation.type === 'line' || annotation.type === 'polygon') {
                annotation.linePattern = linePattern;
            } else if (annotation.type === 'point') {
                delete annotation.linePattern;
            }
        });
    }
    window.annotationStorageModule.saveDataLayers();

    if (window.layerManagerModule && window.layerManagerModule.renderDataLayer) {
        window.layerManagerModule.renderDataLayer(layer);
    }
}

// Restore cleared annotations
async function restoreAnnotations() {
    const layerModule = window.layerManagerModule;
    const rendererModule = window.annotationRendererModule;
    
    if (!layerModule || !rendererModule) {
        console.error('Required modules not available');
        return;
    }
    
    // Reset cleared flag
    layerModule.annotationsLayerCleared = false;
    
    // Re-initialize annotations layer
    layerModule.initAnnotationsLayer();
    
    // Re-render annotations
    rendererModule.renderAnnotations();
    
    // Update layer control
    layerModule.updateLayerControlOverlays();
    
    // Refresh table
    if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
    
    await appAlert('All annotations have been restored to the map.');
}

// Export module (assembled after photo/document/event/service/manage pieces load)
window.tableActionsModule = {
    viewPhoto,
    zoomToPhoto,
    deletePhoto,
    toggleBatchSelection,
    zoomToBatch,
    deleteBatch,
    viewDocument,
    closeDocumentViewer,
    toggleDocumentFullscreen,
    deleteDocument,
    viewEvent,
    closeEventDetailsModal,
    startEventLocationDrawing,
    cancelEventLocationDrawing,
    removeEventLocation,
    zoomToEvent,
    deleteEvent,
    editDataItemName,
    updateDataLayerUtilityType,
    togglePhotoPublic,
    toggleLayerPublic,
    tagPhotoLocation,
    editPhotoManualLocation,
    pickPhotoLocationOnMap,
    openPhotoLocationMenu,
    closePhotoLocationMenu,
    bulkAssociateSelectedPhotos,
    selectionHasNoGpsPhotosForAssociate,
    restoreAnnotations,
    toggleBatchCollapse,
    openServiceRequestModal,
    closeServiceRequestModal,
    submitServiceRequest,
    requestSiteDocumentationForTicket,
    requestSiteDocumentationForTickets
};

// Make functions globally available for HTML onclick handlers
window.viewPhoto = viewPhoto;
window.zoomToPhoto = zoomToPhoto;
window.deletePhoto = deletePhoto;
window.deleteSelectedPhotos = deleteSelectedPhotos;
window.toggleBatchSelection = toggleBatchSelection;
window.zoomToBatch = zoomToBatch;
window.deleteBatch = deleteBatch;
window.viewDocument = viewDocument;
window.closeDocumentViewer = closeDocumentViewer;
window.setDocumentViewerMode = setDocumentViewerMode;
window.toggleDocumentFullscreen = toggleDocumentFullscreen;
window.deleteDocument = deleteDocument;
window.viewEvent = viewEvent;
window.closeEventDetailsModal = closeEventDetailsModal;
window.startEventLocationDrawing = startEventLocationDrawing;
window.cancelEventLocationDrawing = cancelEventLocationDrawing;
window.removeEventLocation = removeEventLocation;
window.zoomToEvent = zoomToEvent;
window.deleteEvent = deleteEvent;
window.promptReportedEventEditPassword = promptReportedEventEditPassword;
window.buildEventMapMarkerPopupHtml = buildEventMapMarkerPopupHtml;
window.wireEventMapMarkerPopup = wireEventMapMarkerPopup;
window.editDataItemName = editDataItemName;
window.updateDataLayerUtilityType = updateDataLayerUtilityType;
window.togglePhotoPublic = togglePhotoPublic;
window.toggleLayerPublic = toggleLayerPublic;
window.bulkMakeSelectedPublic = bulkMakeSelectedPublic;
window.bulkMakeSelectedPrivate = bulkMakeSelectedPrivate;
window.tagPhotoLocation = tagPhotoLocation;
window.editPhotoManualLocation = editPhotoManualLocation;
window.openPhotoLocationMenu = openPhotoLocationMenu;
window.closePhotoLocationMenu = closePhotoLocationMenu;
window.bulkAssociateSelectedPhotos = bulkAssociateSelectedPhotos;
window.selectionHasNoGpsPhotosForAssociate = selectionHasNoGpsPhotosForAssociate;
window.restoreAnnotations = restoreAnnotations;
window.toggleBatchCollapse = toggleBatchCollapse;
window.openServiceRequestModal = openServiceRequestModal;
window.closeServiceRequestModal = closeServiceRequestModal;
window.submitServiceRequest = submitServiceRequest;
window.requestSiteDocumentationForTicket = requestSiteDocumentationForTicket;
window.requestSiteDocumentationForTickets = requestSiteDocumentationForTickets;
