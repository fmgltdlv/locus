/**
 * Offline photo blob cache and upload outbox.
 */
(function () {
    'use strict';

    var MAX_BLOB_BUDGET_BYTES = 200 * 1024 * 1024;
    var flushInFlight = null;

    function newClientPhotoId() {
        if (typeof generateUuid === 'function') return generateUuid();
        return 'offline-photo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    }

    function resolveCurrentOrgId() {
        if (window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function') {
            return window.orgSelectorModule.getCurrentOrgId();
        }
        var u = window.authModule && window.authModule.getCurrentUser && window.authModule.getCurrentUser();
        return u && u.organizationId != null ? u.organizationId : null;
    }

    async function cachePhotoBlob(fileId, blob, kind) {
        if (!window.offlineStore || fileId == null || !blob) return;
        try {
            await window.offlineStore.putPhotoBlob(fileId, blob, kind);
        } catch (e) {
            console.warn('[offlinePhotos] cache blob:', e.message || e);
        }
    }

    async function getCachedPhotoObjectUrl(fileId, kind) {
        if (!window.offlineStore || fileId == null) return null;
        try {
            var row = await window.offlineStore.getPhotoBlob(fileId);
            if (!row || !row.blob) return null;
            if (kind && row.kind !== kind) {
                /* still usable */
            }
            return URL.createObjectURL(row.blob);
        } catch (_e) {
            return null;
        }
    }

    function offlineThumbnailBlobKey(clientPhotoId) {
        return 'offline-thumb-' + String(clientPhotoId);
    }

    async function generateAndCacheOfflineThumbnail(file, clientPhotoId) {
        if (!file || clientPhotoId == null) return null;
        try {
            var blob = null;
            if (
                window.photoCanvasUtils &&
                typeof window.photoCanvasUtils.generateJpegThumbnailBlob === 'function'
            ) {
                blob = await window.photoCanvasUtils.generateJpegThumbnailBlob(file);
            }
            if (!blob) return null;
            await cachePhotoBlob(offlineThumbnailBlobKey(clientPhotoId), blob, 'thumb');
            return blob;
        } catch (e) {
            console.warn('[offlinePhotos] thumb:', e.message || e);
            return null;
        }
    }

    async function getOfflineThumbnailObjectUrl(clientPhotoId) {
        return getCachedPhotoObjectUrl(offlineThumbnailBlobKey(clientPhotoId), 'thumb');
    }

    async function removeOfflineThumbnail(clientPhotoId) {
        if (!window.offlineStore || clientPhotoId == null) return;
        try {
            await window.offlineStore.remove('photoBlobs', offlineThumbnailBlobKey(clientPhotoId));
        } catch (_e) {
            /* non-fatal */
        }
    }

    async function hydrateOfflinePendingPhotoPreviews(photos) {
        if (!Array.isArray(photos) || !photos.length) return;
        var pending = window.offlineStore ? await window.offlineStore.listPendingUploads() : [];
        var pendingByClientId = {};
        pending.forEach(function (entry) {
            if (entry && entry.clientPhotoId) {
                pendingByClientId[entry.clientPhotoId] = entry;
            }
        });
        for (var i = 0; i < photos.length; i++) {
            var photo = photos[i];
            if (!photo || !photo.offlinePendingUpload || !photo.offlineClientPhotoId) continue;
            var clientId = photo.offlineClientPhotoId;
            if (!photo.thumbnailUrl || !String(photo.thumbnailUrl).startsWith('blob:')) {
                var thumbUrl = await getOfflineThumbnailObjectUrl(clientId);
                if (thumbUrl) {
                    photo.thumbnailUrl = thumbUrl;
                    photo._offlineThumbPreview = true;
                }
            }
            if (!photo.imageUrl || !String(photo.imageUrl).startsWith('blob:')) {
                var uploadEntry = pendingByClientId[clientId];
                if (uploadEntry && uploadEntry.jpegBlob) {
                    photo.imageUrl = URL.createObjectURL(uploadEntry.jpegBlob);
                    photo._offlineBlobPreview = true;
                }
            }
        }
    }

    async function persistPhotoMetaFromMemory(orgId) {
        if (!window.offlineStore) return;
        var photos = window.photosModule && window.photosModule.savedPhotos;
        var batches = window.photosModule && window.photosModule.photoBatches;
        if (!Array.isArray(photos)) return;
        var oid = orgId != null ? orgId : resolveCurrentOrgId();
        var filtered = photos.filter(function (p) {
            return p && Number(p.organizationId) === Number(oid);
        });
        try {
            await window.offlineStore.putPhotoMeta(oid, filtered, Array.isArray(batches) ? batches : []);
        } catch (e) {
            console.warn('[offlinePhotos] persist meta:', e.message || e);
        }
    }

    async function loadPhotoMetaIntoMemory(orgId) {
        if (!window.offlineStore || !window.photosModule) return false;
        var oid = orgId != null ? orgId : resolveCurrentOrgId();
        try {
            var row = await window.offlineStore.getPhotoMeta(oid);
            if (!row || !Array.isArray(row.photos)) return false;
            var pending = await window.offlineStore.listPendingUploads();
            var pendingPhotos = pending
                .filter(function (p) {
                    return Number(p.orgId) === Number(oid);
                })
                .map(function (p) {
                    return p.localPhotoRecord;
                })
                .filter(Boolean);
            if (typeof window.photosModule.replaceOrgPhotosFromOfflineCache === 'function') {
                window.photosModule.replaceOrgPhotosFromOfflineCache(oid, row.photos, row.batches, pendingPhotos);
            }
            if (window.photosModule && Array.isArray(window.photosModule.savedPhotos)) {
                await hydrateOfflinePendingPhotoPreviews(window.photosModule.savedPhotos);
            }
            return true;
        } catch (e) {
            console.warn('[offlinePhotos] load meta:', e.message || e);
            return false;
        }
    }

    async function enqueueOfflinePhotoUpload(bundle, localPhotoRecord) {
        if (!window.offlineStore || !bundle || !bundle.file) return null;
        var clientPhotoId =
            (localPhotoRecord && localPhotoRecord.offlineClientPhotoId) || newClientPhotoId();
        var orgId = resolveCurrentOrgId();
        var capturedAt =
            bundle.exifData && bundle.exifData.dateTimeOriginal
                ? bundle.exifData.dateTimeOriginal
                : new Date().toISOString();
        try {
            var bytes = await window.offlineStore.estimateBlobBytes();
            if (bytes + bundle.file.size > MAX_BLOB_BUDGET_BYTES) {
                if (typeof window.appAlert === 'function') {
                    void window.appAlert('Offline photo storage is full. Connect and sync before capturing more photos.');
                }
                return null;
            }
            await window.offlineStore.putPendingUpload(clientPhotoId, {
                jpegBlob: bundle.file,
                metadata: bundle.uploadManifest || {},
                exifData: bundle.exifData || {},
                latlng: bundle.latlng || null,
                originalFileName: bundle.originalFileName || 'photo.jpg',
                capturedAt: capturedAt,
                orgId: orgId,
                retries: 0,
                localPhotoRecord: localPhotoRecord || null,
            });
            if (window.offlineUi && window.offlineUi.updateAccountMenuPendingLabel) {
                window.offlineUi.updateAccountMenuPendingLabel();
            }
            return clientPhotoId;
        } catch (e) {
            console.warn('[offlinePhotos] enqueue:', e.message || e);
            return null;
        }
    }

    async function uploadOnePendingEntry(entry) {
        if (!entry || !entry.jpegBlob || !window.authModule || !window.authModule.isAuthenticated()) return false;
        var formData = new FormData();
        formData.append('file', entry.jpegBlob, entry.originalFileName || 'photo.jpg');
        formData.append('fileType', 'photo');
        var metadata = {
            exif: entry.exifData || {},
            hasGPS: !!(entry.latlng && Number.isFinite(entry.latlng.lat)),
            originalFileName: entry.originalFileName || 'photo.jpg',
            offlineCapturedAt: entry.capturedAt,
        };
        if (entry.metadata && typeof entry.metadata === 'object') {
            Object.assign(metadata, entry.metadata);
        }
        if (entry.latlng) {
            metadata.lat = entry.latlng.lat;
            metadata.lng = entry.latlng.lng;
        }
        if (entry.orgId != null) formData.append('organizationId', String(entry.orgId));
        formData.append('metadata', JSON.stringify(metadata));
        var headers =
            window.authModule.getAuthHeaders && window.authModule.getAuthHeaders()
                ? window.authModule.getAuthHeaders()
                : { Authorization: 'Bearer ' + (localStorage.getItem('authToken') || '') };
        var response = await fetch(window.authModule.API_BASE + '/data/media', {
            method: 'POST',
            headers: headers,
            body: formData,
        });
        if (!response.ok) {
            var err = new Error('Upload failed: ' + response.statusText);
            err.status = response.status;
            throw err;
        }
        return response.json();
    }

    function flushPendingMediaUploads() {
        if (flushInFlight) return flushInFlight;
        flushInFlight = (async function () {
            if (!window.offlineStore) return;
            var conn = window.offlineConnectivity;
            if (conn && !conn.isOnline()) return;
            var list = await window.offlineStore.listPendingUploads();
            if (!list.length) return;
            var uploadedCount = 0;
            for (var i = 0; i < list.length; i++) {
                var entry = list[i];
                try {
                    var result = await uploadOnePendingEntry(entry);
                    await window.offlineStore.removePendingUpload(entry.clientPhotoId);
                    uploadedCount += 1;
                    if (
                        window.photosModule &&
                        typeof window.photosModule.reconcileOfflineUploadSuccess === 'function'
                    ) {
                        window.photosModule.reconcileOfflineUploadSuccess(entry, result);
                    }
                } catch (err) {
                    console.warn('[offlinePhotos] upload retry:', err.message || err);
                    entry.retries = (entry.retries || 0) + 1;
                    try {
                        await window.offlineStore.putPendingUpload(entry.clientPhotoId, entry);
                    } catch (_e2) {
                        /* */
                    }
                }
            }
            if (
                uploadedCount > 0 &&
                window.photosModule &&
                typeof window.photosModule.invalidateManageDataPhotosSync === 'function'
            ) {
                window.photosModule.invalidateManageDataPhotosSync();
            }
            if (
                uploadedCount > 0 &&
                window.photosModule &&
                typeof window.photosModule.ensureManageDataPhotosLoaded === 'function'
            ) {
                try {
                    await window.photosModule.ensureManageDataPhotosLoaded();
                } catch (reloadErr) {
                    console.warn('[offlinePhotos] post-sync photo reload:', reloadErr.message || reloadErr);
                }
            }
            if (uploadedCount > 0 && window.refreshDataWindow) {
                window.refreshDataWindow();
            }
            if (window.offlineUi && window.offlineUi.updateAccountMenuPendingLabel) {
                window.offlineUi.updateAccountMenuPendingLabel();
            }
        })().finally(function () {
            flushInFlight = null;
        });
        return flushInFlight;
    }

    async function prefetchThumbnailsForFileIds(fileIds, maxCount) {
        if (!window.offlineStore || !window.authModule) return;
        var conn = window.offlineConnectivity;
        if (conn && !conn.isOnline()) return;
        var limit = maxCount != null ? maxCount : 50;
        var ids = (fileIds || []).filter(function (id) {
            return id != null;
        });
        for (var i = 0; i < ids.length && i < limit; i++) {
            var fileId = ids[i];
            try {
                if (window.photosModule && typeof window.photosModule.fetchThumbnailBlobForOffline === 'function') {
                    var blob = await window.photosModule.fetchThumbnailBlobForOffline(fileId);
                    if (blob) await cachePhotoBlob(fileId, blob, 'thumb');
                }
            } catch (_e) {
                /* per-photo */
            }
        }
    }

    window.offlinePhotos = {
        cachePhotoBlob: cachePhotoBlob,
        getCachedPhotoObjectUrl: getCachedPhotoObjectUrl,
        offlineThumbnailBlobKey: offlineThumbnailBlobKey,
        generateAndCacheOfflineThumbnail: generateAndCacheOfflineThumbnail,
        getOfflineThumbnailObjectUrl: getOfflineThumbnailObjectUrl,
        removeOfflineThumbnail: removeOfflineThumbnail,
        hydrateOfflinePendingPhotoPreviews: hydrateOfflinePendingPhotoPreviews,
        persistPhotoMetaFromMemory: persistPhotoMetaFromMemory,
        loadPhotoMetaIntoMemory: loadPhotoMetaIntoMemory,
        enqueueOfflinePhotoUpload: enqueueOfflinePhotoUpload,
        flushPendingMediaUploads: flushPendingMediaUploads,
        prefetchThumbnailsForFileIds: prefetchThumbnailsForFileIds,
        newClientPhotoId: newClientPhotoId,
    };
})();
