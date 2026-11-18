/**
 * Orchestrates offline outbox flush and shared resume-busy checks.
 */
(function () {
    'use strict';

    function isUserBusyForResume() {
        if (window.photosModule && typeof window.photosModule.isInPageCameraOverlayOpen === 'function') {
            if (window.photosModule.isInPageCameraOverlayOpen()) return true;
        }
        var cam = document.getElementById('inPageCameraOverlay');
        if (cam && cam.style.display !== 'none' && cam.getAttribute('aria-hidden') !== 'true') return true;

        if (window.photosModule && typeof window.photosModule.hasActivePhotoUploadWork === 'function') {
            if (window.photosModule.hasActivePhotoUploadWork()) return true;
        }
        var status = document.getElementById('photoUploadStatus');
        if (status && status.style.display !== 'none') {
            if (
                !status.classList.contains('photo-upload-status-success') &&
                !status.classList.contains('photo-upload-status-error')
            ) {
                return true;
            }
        }
        if (window.photoUploadMode) return true;
        if (window.drawingModule && window.drawingModule.currentDrawingMode) return true;
        if (window.annotationsModule && window.annotationsModule.multiDrawActive) return true;
        var modal = document.getElementById('annotationModal');
        if (modal && modal.style.display !== 'none') return true;
        if (window.submitJobPoller && typeof window.submitJobPoller.hasActiveOwnJobs === 'function') {
            if (window.submitJobPoller.hasActiveOwnJobs()) return true;
        }
        return false;
    }

    async function hasPendingOutboxWork() {
        if (window.offlineStore) {
            try {
                var uploads = await window.offlineStore.listPendingUploads();
                var notes = await window.offlineStore.listPendingNotes();
                if (uploads.length || notes.length) return true;
            } catch (_e) {
                /* fall through */
            }
        }
        return false;
    }

    async function flushAllOutboxes() {
        var conn = window.offlineConnectivity;
        if (conn && !conn.isOnline()) return;

        var showSync = await hasPendingOutboxWork();
        if (showSync && window.offlineUi && typeof window.offlineUi.setReconnectSyncing === 'function') {
            window.offlineUi.setReconnectSyncing(true);
        }

        try {
            if (window.offlinePhotos && window.offlinePhotos.flushPendingMediaUploads) {
                await window.offlinePhotos.flushPendingMediaUploads();
            }
            if (window.offlineNotes && window.offlineNotes.flushPendingTicketNotes) {
                await window.offlineNotes.flushPendingTicketNotes();
            }
            if (window.photosModule && typeof window.photosModule.flushPendingMediaDeletes === 'function') {
                await window.photosModule.flushPendingMediaDeletes();
            }
            if (window.offlineUi && window.offlineUi.updateAccountMenuPendingLabel) {
                window.offlineUi.updateAccountMenuPendingLabel();
            }
        } finally {
            if (showSync && window.offlineUi && typeof window.offlineUi.setReconnectSyncing === 'function') {
                window.offlineUi.setReconnectSyncing(false);
            }
        }
    }

    window.offlineSync = {
        isUserBusyForResume: isUserBusyForResume,
        flushAllOutboxes: flushAllOutboxes,
    };
})();
