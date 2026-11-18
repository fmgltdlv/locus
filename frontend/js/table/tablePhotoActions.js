/**
 * tablePhotoActions.js — split from tableActions.js (Phase F4).
 * Photo view/zoom/delete, batch selection, public toggle, manual GPS pick.
 */
// View photo in viewer
function viewPhoto(photoId, options) {
    const photo =
        typeof findPhotoForUi === 'function'
            ? findPhotoForUi(photoId)
            : (window.photosModule?.savedPhotos || []).find(
                  (p) => p && String(p.id) === String(photoId)
              );
    if (!photo || !window.openPhotoViewer) return;

    const opts = options && typeof options === 'object' ? options : {};
    const galleryList =
        opts.fromManageDataPhotosGallery &&
        window.photosTableRenderer &&
        typeof window.photosTableRenderer.getSortedFilteredPhotos === 'function'
            ? window.photosTableRenderer.getSortedFilteredPhotos()
            : null;
    if (galleryList && galleryList.length >= 2) {
        const galleryIndex = galleryList.findIndex((p) => p && String(p.id) === String(photoId));
        if (galleryIndex >= 0) {
            window.openPhotoViewer(photo, photo.fileName, {
                gallery: galleryList,
                galleryIndex,
            });
            return;
        }
    }
    window.openPhotoViewer(photo, photo.fileName);
}

// On mobile only: close manage data window so the map is visible after zoom
function closeMobilePanelsIfNeeded() {
    if (typeof window !== 'undefined' && window.innerWidth <= 768) {
        if (window.closeDataWindow) window.closeDataWindow();
    }
}

// Zoom to photo location
function zoomToPhoto(photoId) {
    closeMobilePanelsIfNeeded();
    const photos = window.photosModule?.savedPhotos || [];
    const photo = photos.find(p => p.id === photoId);
    if (!photo) return;
    if (
        window.photoMapLoaderModule &&
        typeof window.photoMapLoaderModule.showPhotoOnMapOneOff === 'function' &&
        (photo.latlng || (photo.lat != null && photo.lng != null))
    ) {
        window.photoMapLoaderModule.showPhotoOnMapOneOff(photo);
        return;
    }
    if (photo && photo.latlng && window.map) {
        window.map.setView([photo.latlng.lat, photo.latlng.lng], Math.max(window.map.getZoom(), 15));
    }
}

// Delete photo (from Data tab) - deletes on server when photo has fileId, then removes locally
function closePhotoDetailUiBeforeDelete() {
    if (typeof window.closePhotoViewer === 'function') {
        window.closePhotoViewer();
    }
    if (typeof window.closePhotoMapInfoModal === 'function') {
        window.closePhotoMapInfoModal();
    }
    if (window.map && typeof window.map.closePopup === 'function') {
        window.map.closePopup();
    }
}

async function tryDeletePhotoMediaOnServer(photo, currentOrgId) {
    if (!photo || !photo.fileId || !window.photosModule || !window.photosModule.deleteMediaFileOnServer) {
        return true;
    }
    try {
        await window.photosModule.deleteMediaFileOnServer(photo.fileId, currentOrgId);
        return true;
    } catch (err) {
        console.error('Error deleting photo from server:', err);
        if ((!err.status || err.status >= 500) && window.photosModule.enqueuePendingMediaDelete) {
            window.photosModule.enqueuePendingMediaDelete(photo.fileId, currentOrgId, photo.id);
        }
        return false;
    }
}

function applyLocalPhotoDeletes(deletedPhotos) {
    if (!deletedPhotos || !deletedPhotos.length) return;
    const photos = window.photosModule?.savedPhotos || [];
    const selectedDataIds = window.dataSelectionModule?.selectedDataIds || new Set();
    deletedPhotos.forEach(function (photo) {
        if (photo.fileId && window.photosModule && window.photosModule.evictPhotoBlobCachesForFile) {
            window.photosModule.evictPhotoBlobCachesForFile(photo.fileId);
        }
        const index = photos.findIndex(function (p) {
            return p.id === photo.id;
        });
        if (index >= 0) {
            photos.splice(index, 1);
        }
        selectedDataIds.delete(photo.id);
    });
    if (window.photosModule && window.photosModule.savePhotos) {
        window.photosModule.savePhotos();
    }
    if (window.photosModule && window.photosModule.reloadPhotosOnMap) {
        window.photosModule.reloadPhotosOnMap();
    } else if (window.photosModule && window.photosModule.updatePhotosLayerControl) {
        window.photosModule.updatePhotosLayerControl();
    }
    if (window.dataSelectionModule) {
        window.dataSelectionModule.updateBulkActionsVisibility();
    }
    if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
    if (deletedPhotos.length && window.ticketsModule && typeof window.ticketsModule.refreshTicketUiAfterPhotoChange === 'function') {
        if (typeof window.ticketsModule.invalidateTicketPhotoIntersectionsForPhoto === 'function') {
            deletedPhotos.forEach(function (p) {
                window.ticketsModule.invalidateTicketPhotoIntersectionsForPhoto(p);
            });
        }
        window.ticketsModule.refreshTicketUiAfterPhotoChange(null, 'photo-delete');
    } else if (window.ticketsModule && typeof window.ticketsModule.refreshOpenTicketPopupAfterPhotoChange === 'function') {
        window.ticketsModule.refreshOpenTicketPopupAfterPhotoChange();
    }
}

/**
 * Server-first delete for one or more photos, then one local cleanup pass.
 * 404 from the server counts as deleted (already gone).
 */
async function deletePhotosFromServerThenLocal(photoIds, confirmMessage, options) {
    if (window.orgDataPermissionsModule && !window.orgDataPermissionsModule.guardDeleteOrgData()) {
        return { deletedCount: 0, failedCount: 0, cancelled: true };
    }
    const opts = options && typeof options === 'object' ? options : {};
    const ids = Array.isArray(photoIds) ? photoIds.filter(Boolean) : [];
    if (!ids.length) {
        return { deletedCount: 0, failedCount: 0, cancelled: false };
    }
    const windowModule = window.dataWindowModule;
    const manageBusy = opts.manageBusy !== false;
    if (windowModule) {
        windowModule.isDeleting = true;
    }
    if (confirmMessage && !(await appConfirm(confirmMessage))) {
        if (windowModule) {
            windowModule.isDeleting = false;
        }
        return { deletedCount: 0, failedCount: 0, cancelled: true };
    }
    if (manageBusy && windowModule?.setDataHubBusy) {
        windowModule.setDataHubBusy(
            true,
            ids.length === 1 ? 'Deleting photo…' : 'Deleting ' + ids.length + ' photos…'
        );
    }

    const photos = window.photosModule?.savedPhotos || [];
    const currentOrgId = typeof window.getCurrentOrgId === 'function' ? window.getCurrentOrgId() : null;
    const deletedPhotos = [];
    let failedCount = 0;
    closePhotoDetailUiBeforeDelete();

    for (var i = 0; i < ids.length; i++) {
        if (
            ids.length > 1 &&
            windowModule?.updateDataHubBusyMessage &&
            (manageBusy || (typeof windowModule.isDataHubBusy === 'function' && windowModule.isDataHubBusy()))
        ) {
            windowModule.updateDataHubBusyMessage('Deleting photos… (' + (i + 1) + '/' + ids.length + ')');
        }
        const photo = photos.find(function (p) {
            return p.id === ids[i];
        });
        if (!photo) continue;
        const ok = await tryDeletePhotoMediaOnServer(photo, currentOrgId);
        if (!ok) {
            failedCount++;
            continue;
        }
        deletedPhotos.push(photo);
    }

    applyLocalPhotoDeletes(deletedPhotos);
    if (manageBusy && windowModule?.setDataHubBusy) {
        windowModule.setDataHubBusy(false);
    }
    if (windowModule) {
        windowModule.isDeleting = false;
    }
    return { deletedCount: deletedPhotos.length, failedCount: failedCount, cancelled: false };
}

async function deletePhoto(photoId) {
    const result = await deletePhotosFromServerThenLocal(
        [photoId],
        'Are you sure you want to delete this photo?'
    );
    if (result.cancelled) return;
    if (result.failedCount > 0) {
        await appAlert('Could not delete photo. Check your connection and try again.');
    }
}

/** Bulk Manage Data delete — one confirm, sequential server deletes, single local refresh. */
async function deleteSelectedPhotos(photoIds, options) {
    const ids = Array.isArray(photoIds) ? photoIds.slice() : [];
    if (!ids.length) return;
    const skipConfirm = options && options.skipConfirm;
    const confirmMessage = skipConfirm
        ? null
        : ids.length === 1
          ? 'Are you sure you want to delete this photo?'
          : 'Are you sure you want to delete ' + ids.length + ' photo(s)?';
    const result = await deletePhotosFromServerThenLocal(ids, confirmMessage, {
        manageBusy: !(options && options.skipConfirm),
    });
    if (result.cancelled) return;
    if (result.failedCount > 0) {
        await appAlert(
            result.failedCount +
                ' photo(s) could not be deleted from the server. Check your connection and try again.'
        );
    }
}

// Toggle batch selection
function toggleBatchSelection(batchId) {
    const photos = window.photosModule?.savedPhotos || [];
    const batch = window.photosModule?.photoBatches?.find(b => b.id === batchId);
    
    if (!batch) return;
    
    const selectedDataIds = window.dataSelectionModule?.selectedDataIds || new Set();
    const batchPhotos = photos.filter(p => p.batchId === batchId);
    const allSelected = batchPhotos.every(photo => selectedDataIds.has(photo.id));
    
    if (allSelected) {
        // Deselect all photos in batch
        batchPhotos.forEach(photo => {
            selectedDataIds.delete(photo.id);
        });
    } else {
        // Select all photos in batch
        batchPhotos.forEach(photo => {
            selectedDataIds.add(photo.id);
        });
    }
    
    if (window.dataSelectionModule) {
        if (window.dataSelectionModule.syncSelectAllDataCheckbox) {
            window.dataSelectionModule.syncSelectAllDataCheckbox();
        }
        window.dataSelectionModule.updateBulkActionsVisibility();
    }
    if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
}

// Zoom to batch
function zoomToBatch(batchId) {
    closeMobilePanelsIfNeeded();
    const photos = window.photosModule?.savedPhotos || [];
    const batchPhotos = photos.filter(p => p.batchId === batchId);
    
    if (batchPhotos.length === 0 || !window.map) return;
    
    const allCoords = [];
    batchPhotos.forEach(photo => {
        if (photo.latlng) {
            allCoords.push([photo.latlng.lat, photo.latlng.lng]);
        }
    });
    
    if (allCoords.length > 0) {
        const bounds = L.latLngBounds(allCoords);
        window.map.fitBounds(bounds, { padding: [50, 50] });
    }
}

// Delete batch (deletes each photo on server when it has fileId, then removes locally)
async function deleteBatch(batchId) {
    if (window.orgDataPermissionsModule && !window.orgDataPermissionsModule.guardDeleteOrgData()) {
        return;
    }
    const windowModule = window.dataWindowModule;
    if (windowModule) {
        windowModule.isDeleting = true;
    }
    
    const batch = window.photosModule?.photoBatches?.find(b => b.id === batchId);
    if (!batch) {
        if (windowModule) {
            windowModule.isDeleting = false;
        }
        return;
    }
    
    if (!(await appConfirm(`Are you sure you want to delete the batch "${batch.name}" with ${batch.photoIds.length} photo(s)?`))) {
        if (windowModule) {
            windowModule.isDeleting = false;
        }
        return;
    }
    
    const photos = window.photosModule?.savedPhotos || [];
    const currentOrgId = typeof window.getCurrentOrgId === 'function' ? window.getCurrentOrgId() : null;

    const deletedPhotos = [];
    let failedCount = 0;
    closePhotoDetailUiBeforeDelete();
    for (const photoId of batch.photoIds) {
        const photo = photos.find(p => p.id === photoId);
        if (!photo) continue;
        const ok = await tryDeletePhotoMediaOnServer(photo, currentOrgId);
        if (!ok) {
            failedCount++;
            continue;
        }
        deletedPhotos.push(photo);
    }

    applyLocalPhotoDeletes(deletedPhotos);

    // Remove batch only when every photo was deleted; otherwise keep it for retry
    if (failedCount === 0) {
        const batchIndex = window.photosModule?.photoBatches?.findIndex(b => b.id === batchId);
        if (batchIndex >= 0 && window.photosModule) {
            window.photosModule.photoBatches.splice(batchIndex, 1);
            if (window.photosModule.savePhotoBatches) {
                window.photosModule.savePhotoBatches();
            }
        }
    }

    if (failedCount > 0) {
        await appAlert(`${failedCount} photo(s) could not be deleted from the server. Check your connection and try again.`);
    }

    // Reset flag after a short delay
    setTimeout(() => {
        if (windowModule) {
            windowModule.isDeleting = false;
        }
    }, 100);
}

async function togglePhotoPublic(photoId, fileId, isPublic, checkboxEl) {
    const photosMod = window.photosModule;
    if (!photosMod || !photosMod.setPhotoPublicFlag || fileId == null) return;
    try {
        await photosMod.setPhotoPublicFlag(Number(fileId), !!isPublic);
        if (window.dataTableRendererModule?.renderDataTable) {
            window.dataTableRendererModule.renderDataTable();
        }
    } catch (err) {
        console.error('Failed to update photo public flag:', err);
        if (checkboxEl) checkboxEl.checked = !isPublic;
        if (typeof appAlert === 'function') {
            await appAlert(err.message || 'Could not update public sharing.');
        }
    }
}

async function bulkSetSelectedPhotosPublic(isPublic) {
    const photosMod = window.photosModule;
    if (!photosMod?.canAdminPhotoPublicFlag?.() || !photosMod.setPhotoPublicFlag) return;

    const selected = window.dataSelectionModule?.selectedDataIds;
    if (!selected || selected.size === 0) {
        if (typeof appAlert === 'function') await appAlert('No items selected.');
        return;
    }

    const photos = photosMod.savedPhotos || [];
    const ids = Array.from(selected);
    const eligible = [];
    let skippedShared = 0;
    let skippedNoFile = 0;
    let skippedMissing = 0;

    ids.forEach((id) => {
        const photo = photos.find((p) => String(p.id) === String(id));
        if (!photo) {
            skippedMissing += 1;
            return;
        }
        if (photo.shared) {
            skippedShared += 1;
            return;
        }
        if (photo.fileId == null) {
            skippedNoFile += 1;
            return;
        }
        eligible.push(photo);
    });

    if (eligible.length === 0) {
        const parts = [];
        if (skippedShared) parts.push(`${skippedShared} shared`);
        if (skippedNoFile) parts.push(`${skippedNoFile} not uploaded`);
        if (skippedMissing) parts.push(`${skippedMissing} not found`);
        if (typeof appAlert === 'function') {
            await appAlert(`No eligible photos to update.${parts.length ? ` Skipped: ${parts.join(', ')}.` : ''}`);
        }
        return;
    }

    const action = isPublic ? 'public' : 'private';
    if (typeof appConfirm === 'function') {
        const ok = await appConfirm(`Make ${eligible.length} selected photo(s) ${action}?`);
        if (!ok) return;
    }

    let updated = 0;
    let failed = 0;
    for (const photo of eligible) {
        try {
            await photosMod.setPhotoPublicFlag(Number(photo.fileId), !!isPublic);
            updated += 1;
        } catch (err) {
            failed += 1;
            console.error('Failed to update photo public flag:', err);
        }
    }

    if (window.dataTableRendererModule?.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }

    const summaryParts = [`${updated} updated`];
    const skippedTotal = skippedShared + skippedNoFile + skippedMissing;
    if (skippedTotal) summaryParts.push(`${skippedTotal} skipped`);
    if (failed) summaryParts.push(`${failed} failed`);
    if (typeof appAlert === 'function') {
        await appAlert(`Bulk photo update complete: ${summaryParts.join(', ')}.`);
    }
}

function isPhotoManualGpsForActions(photo) {
    return window.photosModule && window.photosModule.isPhotoManualGps
        ? window.photosModule.isPhotoManualGps(photo)
        : !!(photo && photo.latlng && photo.exifData && photo.exifData.gpsSource === 'Manual');
}

/** Pick a map point for a photo; optional password required when editing existing manual GPS. */
function pickPhotoLocationOnMap(photoId, options) {
    options = options || {};
    const photos = window.photosModule?.savedPhotos || [];
    const photo = photos.find(p => p.id === photoId);
    if (!photo) return;

    const dataWindow = document.getElementById('dataWindow');
    const wasOpen = options.wasOpen != null ? options.wasOpen : dataWindow && dataWindow.classList.contains('show');
    const currentView =
        options.currentView != null
            ? options.currentView
            : wasOpen && window.dataWindowModule
              ? window.dataWindowModule.currentDataView
              : 'photos';
    if (wasOpen && window.closeDataWindow) {
        window.closeDataWindow();
    }

    const map = window.map;
    if (!map) return;

    if (window.drawingModule && window.drawingModule.currentDrawingMode) {
        window.drawingModule.cancelDrawingMode();
    }
    if (window.measureModule && window.measureModule.cancelMeasureMode) {
        window.measureModule.cancelMeasureMode();
    }
    if (window.photosModule && window.photosModule.cancelPhotoLocationTag) {
        window.photosModule.cancelPhotoLocationTag();
    }
    if (window.photosModule && window.photosModule.photoUploadMode && window.photosModule.cancelPhotoUpload) {
        window.photosModule.cancelPhotoUpload();
    }

    const pm = window.photosModule;
    const password = options.password || null;
    const successMessage = options.successMessage || 'Photo location saved successfully!';

    const tagHandler = async function (e) {
        L.DomEvent.stopPropagation(e);

        const lat = e.latlng.lat;
        const lng = e.latlng.lng;
        if (pm && pm.setPhotoGpsLocally) {
            pm.setPhotoGpsLocally(photo, lat, lng);
        } else {
            photo.latlng = { lat, lng };
            if (!photo.exifData) photo.exifData = {};
            photo.exifData.gpsSource = 'Manual';
            photo.exifData.hasGPS = true;
            photo.exifData.gpsLat = lat;
            photo.exifData.gpsLng = lng;
        }

        if (photo.fileId && pm && pm.patchPhotoGpsOnServer) {
            try {
                const data = await pm.patchPhotoGpsOnServer(photo.fileId, lat, lng, password);
                if (data && data.metadata && pm.applyPhotoGpsMetadataFromResponse) {
                    pm.applyPhotoGpsMetadataFromResponse(photo, data.metadata);
                } else if (pm.applyPhotoGpsMetadataFromResponse) {
                    const who =
                        typeof window.getCurrentUserDisplayNameForAnnotation === 'function'
                            ? window.getCurrentUserDisplayNameForAnnotation()
                            : '';
                    if (who) {
                        photo.gpsLastEditedBy = who;
                        photo.gpsLastEditedAt = new Date().toISOString();
                    }
                }
            } catch (err) {
                console.error('Error saving photo location:', err);
                await appAlert(
                    'Photo was updated on this device, but the server location could not be saved: ' +
                        (err.message || err)
                );
            }
        } else if (pm && pm.applyPhotoGpsMetadataFromResponse) {
            const who =
                typeof window.getCurrentUserDisplayNameForAnnotation === 'function'
                    ? window.getCurrentUserDisplayNameForAnnotation()
                    : '';
            if (who) {
                photo.gpsLastEditedBy = who;
                photo.gpsLastEditedAt = new Date().toISOString();
            }
        }

        if (pm && pm.syncPhotoMapAfterGpsChange) {
            pm.syncPhotoMapAfterGpsChange(photo, e.latlng);
        } else if (pm && pm.placeOrMovePhotoMarker) {
            pm.placeOrMovePhotoMarker(photo, e.latlng);
        }
        if (pm && pm.savePhotos) pm.savePhotos();
        if (pm && pm.updatePhotosLayerControl) pm.updatePhotosLayerControl();

        if (pm && pm.finishPhotoLocationTagClick) {
            pm.finishPhotoLocationTagClick(tagHandler);
        } else {
            map.off('click', tagHandler);
            map.getContainer().style.cursor = '';
        }

        if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
            window.dataTableRendererModule.renderDataTable();
        }
        if (wasOpen && window.openDataWindow) {
            setTimeout(() => window.openDataWindow(), 100);
        }
        await appAlert(successMessage);
    };

    if (pm && pm.startPhotoLocationTagClick) {
        pm.startPhotoLocationTagClick(tagHandler);
    } else {
        map.getContainer().style.cursor = 'crosshair';
        map.on('click', tagHandler);
    }

    const promptMessage = options.promptMessage || 'Click on the map to set the location for this photo.';
    void appAlert(promptMessage);
}

// Tag photo location on map (for photos with no GPS)
function tagPhotoLocation(photoId) {
    pickPhotoLocationOnMap(photoId, {
        promptMessage: 'Click on the map to tag the location for this photo.',
        successMessage: 'Photo location tagged successfully!',
    });
}

/**
 * @returns {Promise<'change'|'remove'|null>}
 */
function promptPhotoManualGpsEditChoice() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText =
            'position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); z-index: 75000; display: flex; align-items: center; justify-content: center; padding: 1rem;';

        const panel = document.createElement('div');
        panel.style.cssText =
            'background: var(--app-bg-page); border: 1px solid var(--app-border); border-radius: 0.5rem; padding: 1.25rem; max-width: 28rem; width: 100%;';

        const titleEl = document.createElement('h3');
        titleEl.textContent = 'Edit GPS';
        titleEl.style.cssText =
            'margin: 0 0 0.75rem; color: var(--app-text-inverse); font-size: 1.125rem; font-weight: 600;';

        const msg = document.createElement('p');
        msg.textContent =
            'Change this photo\u2019s manual GPS location on the map, or remove GPS coordinates entirely.';
        msg.style.cssText =
            'margin: 0 0 1rem; color: var(--app-text-secondary); font-size: 0.875rem; line-height: 1.4;';

        const actions = document.createElement('div');
        actions.style.cssText = 'display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: flex-end;';

        const btnBase =
            'padding: 0.5rem 1rem; border-radius: 0.375rem; cursor: pointer; font-weight: 500; font-size: 0.875rem;';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText =
            btnBase +
            ' background: var(--app-bg-muted); color: var(--app-text-primary); border: 1px solid var(--app-border);';

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = 'Remove GPS';
        removeBtn.style.cssText =
            btnBase + ' background: var(--app-danger); color: var(--app-text-inverse); border: none;';

        const changeBtn = document.createElement('button');
        changeBtn.type = 'button';
        changeBtn.textContent = 'Change location';
        changeBtn.style.cssText =
            btnBase +
            ' background: var(--app-accent); color: var(--app-button-primary-text, var(--app-text-inverse)); border: none;';

        function cleanup(result) {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            document.body.style.overflow = '';
            resolve(result);
        }

        function onKey(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                cleanup(null);
            }
        }

        cancelBtn.onclick = () => cleanup(null);
        removeBtn.onclick = () => cleanup('remove');
        changeBtn.onclick = () => cleanup('change');

        document.addEventListener('keydown', onKey);
        actions.appendChild(cancelBtn);
        actions.appendChild(removeBtn);
        actions.appendChild(changeBtn);
        panel.appendChild(titleEl);
        panel.appendChild(msg);
        panel.appendChild(actions);
        overlay.appendChild(panel);
        document.body.style.overflow = 'hidden';
        document.body.appendChild(overlay);
        changeBtn.focus();
    });
}

async function removePhotoManualGps(photoId, options) {
    options = options || {};
    const photos = window.photosModule?.savedPhotos || [];
    const photo = photos.find((p) => p.id === photoId);
    if (!photo) return;
    if (!isPhotoManualGpsForActions(photo)) {
        void appAlert('Only photos with a manual GPS location can have GPS removed this way.');
        return;
    }

    if (options.confirm !== false) {
        if (
            !(await appConfirm(
                'Remove GPS coordinates from this photo? The photo will no longer appear on the map by location.',
                { title: 'Remove GPS', confirmText: 'Remove GPS', cancelText: 'Cancel' }
            ))
        ) {
            return;
        }
    }

    const password = await appPasswordPrompt(
        'Enter your account password to remove this photo\u2019s manual GPS coordinates.',
        { title: 'Confirm password', confirmText: 'Remove GPS' }
    );
    if (!password) return;

    const pm = window.photosModule;
    if (pm && pm.clearPhotoGpsLocally) {
        pm.clearPhotoGpsLocally(photo);
    } else {
        delete photo.latlng;
        if (photo.exifData) {
            photo.exifData.gpsSource = 'None';
            photo.exifData.hasGPS = false;
            delete photo.exifData.gpsLat;
            delete photo.exifData.gpsLng;
        }
    }

    if (pm && pm.syncPhotoMapAfterGpsChange) {
        pm.syncPhotoMapAfterGpsChange(photo, null);
    } else if (pm && pm.removePhotoMarker) {
        pm.removePhotoMarker(photo);
    } else if (photo.marker && window.map) {
        if (window.map.hasLayer(photo.marker)) window.map.removeLayer(photo.marker);
        photo.marker = null;
    }

    if (photo.fileId && pm && pm.clearPhotoGpsOnServer) {
        try {
            const data = await pm.clearPhotoGpsOnServer(photo.fileId, password);
            if (data && data.metadata && pm.applyPhotoGpsMetadataFromResponse) {
                pm.applyPhotoGpsMetadataFromResponse(photo, data.metadata);
            }
        } catch (err) {
            console.error('Error removing photo GPS:', err);
            await appAlert(
                'Photo was updated on this device, but the server could not remove GPS: ' + (err.message || err)
            );
        }
    }

    if (pm && pm.savePhotos) pm.savePhotos();
    if (pm && pm.updatePhotosLayerControl) pm.updatePhotosLayerControl();

    if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
    if (window.ticketsModule && typeof window.ticketsModule.refreshOpenTicketPopupAfterPhotoChange === 'function') {
        window.ticketsModule.refreshOpenTicketPopupAfterPhotoChange({
            lat: null,
            lng: null,
            requirePointMatch: false,
        });
    }

    await appAlert('GPS coordinates removed from this photo.');
}

/** Change or remove manually tagged GPS — requires account password confirmation. */
async function editPhotoManualLocation(photoId) {
    const photos = window.photosModule?.savedPhotos || [];
    const photo = photos.find(p => p.id === photoId);
    if (!photo) return;
    if (!isPhotoManualGpsForActions(photo)) {
        void appAlert('Only photos with a manual GPS location can be edited this way.');
        return;
    }

    const choice = await promptPhotoManualGpsEditChoice();
    if (!choice) return;
    if (choice === 'remove') {
        await removePhotoManualGps(photoId, { confirm: false });
        return;
    }

    const password = await appPasswordPrompt(
        'Enter your account password to change this photo\u2019s manual GPS coordinates.',
        { title: 'Confirm password', confirmText: 'Continue' }
    );
    if (!password) return;

    const dataWindow = document.getElementById('dataWindow');
    const wasOpen = dataWindow && dataWindow.classList.contains('show');
    const currentView = wasOpen && window.dataWindowModule ? window.dataWindowModule.currentDataView : 'photos';

    pickPhotoLocationOnMap(photoId, {
        password,
        wasOpen,
        currentView,
        promptMessage: 'Click on the map to set the new location for this photo.',
        successMessage: 'Manual GPS location updated successfully!',
    });
}

let photoLocationMenuEl = null;
let photoLocationMenuOutsideHandler = null;

function closePhotoLocationMenu() {
    if (photoLocationMenuEl) {
        photoLocationMenuEl.hidden = true;
    }
    if (photoLocationMenuOutsideHandler) {
        document.removeEventListener('click', photoLocationMenuOutsideHandler, true);
        photoLocationMenuOutsideHandler = null;
    }
}

function ensurePhotoLocationMenu() {
    if (photoLocationMenuEl && photoLocationMenuEl.isConnected) return photoLocationMenuEl;
    photoLocationMenuEl = document.createElement('div');
    photoLocationMenuEl.id = 'photoLocationMenu';
    photoLocationMenuEl.className = 'photos-location-menu';
    photoLocationMenuEl.hidden = true;
    photoLocationMenuEl.setAttribute('role', 'menu');
    document.body.appendChild(photoLocationMenuEl);
    photoLocationMenuEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.getAttribute('data-action');
        const id = btn.getAttribute('data-id');
        closePhotoLocationMenu();
        if (action === 'tag-photo' && id) {
            if (typeof window.tagPhotoLocation === 'function') window.tagPhotoLocation(id);
        } else if (action === 'associate-photo-ticket' && id) {
            if (typeof window.associatePhotoFromManageData === 'function') {
                window.associatePhotoFromManageData(id);
            }
        }
    });
    return photoLocationMenuEl;
}

function photoIsAlreadyAssociated(photo) {
    const mod = window.photoTicketAssociationModule;
    if (mod && typeof mod.getPhotoAssociatedTicketId === 'function') {
        return mod.getPhotoAssociatedTicketId(photo) != null;
    }
    return !!(photo && photo.associatedTicketId != null && photo.associatedTicketId !== '');
}

function photoEligibleForAssociate(photo) {
    return photoHasNoGpsForAssociate(photo) && !photoIsAlreadyAssociated(photo);
}

function openPhotoLocationMenu(photoId, anchorEl) {
    const menu = ensurePhotoLocationMenu();
    const idAttr = typeof escapeHtmlAttr === 'function' ? escapeHtmlAttr(String(photoId)) : String(photoId);
    const photos = window.photosModule?.savedPhotos || [];
    const photo = photos.find((p) => String(p.id) === String(photoId));
    const associateBtn = photoIsAlreadyAssociated(photo)
        ? ''
        : `<button type="button" role="menuitem" class="photos-location-menu__item" data-action="associate-photo-ticket" data-id="${idAttr}">Associate to ticket</button>`;
    menu.innerHTML = `
        <button type="button" role="menuitem" class="photos-location-menu__item" data-action="tag-photo" data-id="${idAttr}">Tag GPS on map</button>
        ${associateBtn}
    `;
    menu.hidden = false;
    const anchor = anchorEl && anchorEl.getBoundingClientRect ? anchorEl : null;
    const rect = anchor ? anchor.getBoundingClientRect() : { left: 8, bottom: 40, right: 120 };
    const top = Math.min(window.innerHeight - 8, rect.bottom + 4);
    let left = rect.left;
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
    // After paint, clamp horizontally
    requestAnimationFrame(() => {
        const w = menu.offsetWidth || 180;
        left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
        menu.style.left = left + 'px';
    });

    if (photoLocationMenuOutsideHandler) {
        document.removeEventListener('click', photoLocationMenuOutsideHandler, true);
    }
    photoLocationMenuOutsideHandler = (e) => {
        if (menu.contains(e.target)) return;
        if (anchorEl && (anchorEl === e.target || (anchorEl.contains && anchorEl.contains(e.target)))) return;
        closePhotoLocationMenu();
    };
    setTimeout(() => document.addEventListener('click', photoLocationMenuOutsideHandler, true), 0);
}

function photoHasNoGpsForAssociate(photo) {
    const mod = window.photoTicketAssociationModule;
    if (mod && typeof mod.photoHasCoordinates === 'function') {
        return !mod.photoHasCoordinates(photo);
    }
    return !(photo && (photo.latlng || (photo.lat != null && photo.lng != null)));
}

function getSelectedNoGpsPhotoFileIds() {
    const selected = window.dataSelectionModule?.selectedDataIds;
    if (!selected || selected.size === 0) return [];
    const photos = window.photosModule?.savedPhotos || [];
    const fileIds = [];
    selected.forEach((id) => {
        const photo = photos.find((p) => String(p.id) === String(id));
        if (!photo || photo.fileId == null) return;
        if (!photoEligibleForAssociate(photo)) return;
        const fid = Number(photo.fileId);
        if (Number.isFinite(fid)) fileIds.push(fid);
    });
    return [...new Set(fileIds)];
}

function selectionHasNoGpsPhotosForAssociate() {
    return getSelectedNoGpsPhotoFileIds().length > 0;
}

function countSelectedPhotosByGps() {
    const selected = window.dataSelectionModule?.selectedDataIds;
    const photos = window.photosModule?.savedPhotos || [];
    let withGps = 0;
    let noGpsEligible = 0;
    let noGpsMissingFile = 0;
    let noGpsAlreadyAssociated = 0;
    if (!selected || selected.size === 0) {
        return { withGps, noGpsEligible, noGpsMissingFile, noGpsAlreadyAssociated, total: 0 };
    }
    selected.forEach((id) => {
        const photo = photos.find((p) => String(p.id) === String(id));
        if (!photo) return;
        if (!photoHasNoGpsForAssociate(photo)) {
            withGps += 1;
            return;
        }
        if (photoIsAlreadyAssociated(photo)) {
            noGpsAlreadyAssociated += 1;
            return;
        }
        if (photo.fileId == null || !Number.isFinite(Number(photo.fileId))) {
            noGpsMissingFile += 1;
            return;
        }
        noGpsEligible += 1;
    });
    return {
        withGps,
        noGpsEligible,
        noGpsMissingFile,
        noGpsAlreadyAssociated,
        total: selected.size,
    };
}

async function bulkAssociateSelectedPhotos() {
    const counts = countSelectedPhotosByGps();
    const fileIds = getSelectedNoGpsPhotoFileIds();
    if (!fileIds.length) {
        await appAlert('Select photos without GPS to associate them to a ticket.');
        return;
    }
    let confirmMsg =
        fileIds.length === 1
            ? 'Associate 1 photo (no GPS) to a ticket?'
            : `Associate ${fileIds.length} photos (no GPS) to a ticket?`;
    if (counts.withGps > 0) {
        confirmMsg +=
            counts.withGps === 1
                ? ' 1 selected photo with GPS will be skipped.'
                : ` ${counts.withGps} selected photos with GPS will be skipped.`;
    }
    if (counts.noGpsAlreadyAssociated > 0) {
        confirmMsg +=
            counts.noGpsAlreadyAssociated === 1
                ? ' 1 selected photo already linked to a ticket will be skipped.'
                : ` ${counts.noGpsAlreadyAssociated} selected photos already linked to a ticket will be skipped.`;
    }
    if (counts.noGpsMissingFile > 0) {
        confirmMsg +=
            counts.noGpsMissingFile === 1
                ? ' 1 photo can’t be associated yet (not synced).'
                : ` ${counts.noGpsMissingFile} photos can’t be associated yet (not synced).`;
    }
    const ok = await appConfirm(confirmMsg, {
        title: 'Associate to ticket',
        confirmText: 'Continue',
        cancelText: 'Cancel',
    });
    if (!ok) return;

    const mod = window.photoTicketAssociationModule;
    if (!mod || typeof mod.startPhotoTicketAssociationPick !== 'function') {
        await appAlert('Ticket association is not available.');
        return;
    }
    await mod.startPhotoTicketAssociationPick(fileIds, {
        source: 'manage_data_bulk',
        reopenTicketPopup: true,
    });
}

// Toggle batch collapse state
function toggleBatchCollapse(batchId, event) {
    // Stop event propagation to prevent closing the data window
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    
    const batchCollapsedKey = `batch-${batchId}-collapsed`;
    const isCollapsed = localStorage.getItem(batchCollapsedKey) === 'true';
    localStorage.setItem(batchCollapsedKey, (!isCollapsed).toString());
    
    // Refresh the table to show/hide photos
    if (window.refreshDataWindow) {
        window.refreshDataWindow();
    }
}
