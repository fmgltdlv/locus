/**
 * photos-manage-data.js — split from photos-core.js (Phase F5).
 * Server load, manage-data sync, savePhotos persistence.
 */
async function loadPhotosFromServer() {
    const currentOrgId = resolveCurrentOrgId();
    if (!currentOrgId || !window.authModule || !window.authModule.isAuthenticated()) return;

    // Retry any queued deletes first so a deleted-but-pending photo doesn't reappear
    try {
        await flushPendingMediaDeletes();
    } catch (_) { /* retried next flush */ }

    try {
        loadPhotoBatches();
        const preMergeOrg = savedPhotos.filter(p => p.organizationId === currentOrgId);
        const fileIdToBatchId = {};
        preMergeOrg.forEach(p => {
            if (p.fileId != null && p.batchId) {
                fileIdToBatchId[Number(p.fileId)] = p.batchId;
            }
        });

        const url = `${window.authModule.API_BASE}/data/media?type=photo&organizationId=${currentOrgId}`;
        const response = await fetch(url, {
            headers: (window.authModule && window.authModule.getAuthHeaders) ? window.authModule.getAuthHeaders() : { 'Authorization': 'Bearer ' + (localStorage.getItem('authToken') || '') }
        });
        if (!response.ok) return;

        const files = await response.json();
        const baseUrl = (window.authModule && window.authModule.getApiBaseForMedia)
            ? window.authModule.getApiBaseForMedia()
            : (window.API_BASE_URL || window.location.origin);

        const serverPhotos = (files || []).filter((file) => !isThumbnailStorageFile(file)).map(file => {
            const filename = file.filePath ? file.filePath.replace(/^.*[/\\]/, '') : (file.id + '');
            const imageUrl = `${baseUrl}/api/data/media/${file.id}/file`;
            const thumbnailUrl = file.thumbnailUrl ? `${baseUrl}${file.thumbnailUrl}` : null;
            const metadata = file.metadata || {};
            // metadata may be double-parsed if backend ever stored string; ensure object
            const meta = typeof metadata === 'string' ? (tryParse(metadata) || {}) : metadata;
            const exif = meta.exif && typeof meta.exif === 'object' ? meta.exif : {};
            const lat = meta.lat ?? meta.gpsLat ?? exif.gpsLat;
            const lng = meta.lng ?? meta.gpsLng ?? exif.gpsLng;
            const hasStoredGps =
                meta.hasGPS === true ||
                exif.hasGPS === true ||
                (lat != null &&
                    lng != null &&
                    lat !== '' &&
                    lng !== '' &&
                    Number.isFinite(Number(lat)) &&
                    Number.isFinite(Number(lng)));
            const exifData = {
                dateTime: exif.dateTime ?? null,
                make: exif.make ?? null,
                model: exif.model ?? null,
                orientation: exif.orientation ?? null,
                hasGPS: hasStoredGps,
                gpsLat: hasStoredGps && lat != null ? Number(lat) : exif.gpsLat ?? null,
                gpsLng: hasStoredGps && lng != null ? Number(lng) : exif.gpsLng ?? null,
                gpsSource: exif.gpsSource || meta.gpsSource || (hasStoredGps ? 'EXIF' : 'None'),
            };
            const accM = exif.gpsAccuracyMeters ?? meta.gpsAccuracyMeters;
            if (accM != null && Number.isFinite(Number(accM))) {
                exifData.gpsAccuracyMeters = Number(accM);
            }
            const headingM = exif.gpsHeadingDegrees ?? meta.gpsHeadingDegrees;
            if (headingM != null && Number.isFinite(Number(headingM))) {
                exifData.gpsHeadingDegrees = Number(headingM);
                const headingSrc = exif.gpsHeadingSource || meta.gpsHeadingSource;
                if (headingSrc != null && String(headingSrc).trim() !== '') {
                    exifData.gpsHeadingSource = String(headingSrc);
                }
            }
            if (meta.associatedTicketId != null && Number.isFinite(Number(meta.associatedTicketId))) {
                exifData.associatedTicketId = Number(meta.associatedTicketId);
            }
            if (meta.stakeOfPhotoId != null && meta.stakeOfPhotoId !== '') {
                const stakeId = Number(meta.stakeOfPhotoId);
                if (Number.isFinite(stakeId)) {
                    exifData.stakeOfPhotoId = stakeId;
                }
            }
            if (Number.isFinite(Number(meta.stakeGhostOpacity))) {
                exifData.stakeGhostOpacity = Number(meta.stakeGhostOpacity);
            }
            const batchIdFromMeta = meta.batchId != null && meta.batchId !== '' ? String(meta.batchId) : null;
            const batchId = batchIdFromMeta || fileIdToBatchId[file.id] || null;
            const batchNameHint = typeof meta.batchName === 'string' ? meta.batchName : null;
            const shared = !!file.shared;
            const ownerOrganizationId = shared && file.sharedFromOrganizationId != null
                ? Number(file.sharedFromOrganizationId)
                : Number(currentOrgId);
            return {
                id: `photo-server-${file.id}`,
                fileId: file.id,
                imageUrl: imageUrl,
                thumbnailUrl: thumbnailUrl,
                fileName: file.fileName || filename,
                originalFileName: meta.originalFileName || file.fileName || filename,
                fileSize: file.fileSize || 0,
                latlng: (lat != null && lng != null) ? { lat: Number(lat), lng: Number(lng) } : null,
                exifData,
                createdAt: file.createdAt,
                // Stays as current org so localStorage + loadSavedPhotos keep working for the active org view
                organizationId: currentOrgId,
                ownerOrganizationId,
                batchId: batchId,
                batchNameHint: batchNameHint,
                marker: null,
                note: typeof meta.note === 'string' ? meta.note : '',
                uploadedBy: file.uploadedBy != null && file.uploadedBy !== '' ? String(file.uploadedBy) : '',
                uploadedByUserId:
                    file.uploadedByUserId != null && Number.isFinite(Number(file.uploadedByUserId))
                        ? Number(file.uploadedByUserId)
                        : null,
                noteLastEditedBy: typeof meta.noteLastEditedBy === 'string' ? meta.noteLastEditedBy : '',
                noteLastEditedAt: typeof meta.noteLastEditedAt === 'string' ? meta.noteLastEditedAt : '',
                gpsLastEditedBy: typeof meta.gpsLastEditedBy === 'string' ? meta.gpsLastEditedBy : '',
                gpsLastEditedAt: typeof meta.gpsLastEditedAt === 'string' ? meta.gpsLastEditedAt : '',
                shared,
                sharedFromOrganizationId: file.sharedFromOrganizationId != null ? file.sharedFromOrganizationId : null,
                sharedSourceLabel: file.sharedSourceLabel != null ? String(file.sharedSourceLabel) : null,
                isPublic: !!file.isPublic,
                associatedTicketId:
                    meta.associatedTicketId != null && Number.isFinite(Number(meta.associatedTicketId))
                        ? Number(meta.associatedTicketId)
                        : null,
                associationSource:
                    typeof meta.associationSource === 'string' ? meta.associationSource : null,
                associatedAt: typeof meta.associatedAt === 'string' ? meta.associatedAt : null,
                hasWhitePaintMark: meta.hasWhitePaintMark === true,
                dirtEventId: meta.dirtEventId != null ? String(meta.dirtEventId) : null,
                tags:
                    window.photoTagsModule && typeof window.photoTagsModule.getPhotoTagsFromMeta === 'function'
                        ? window.photoTagsModule.getPhotoTagsFromMeta(meta)
                        : Array.isArray(meta.tags)
                          ? meta.tags
                          : meta.hasWhitePaintMark === true
                            ? ['White Paint']
                            : [],
                stakeOfPhotoId:
                    meta.stakeOfPhotoId != null && meta.stakeOfPhotoId !== '' && Number.isFinite(Number(meta.stakeOfPhotoId))
                        ? Number(meta.stakeOfPhotoId)
                        : null,
                stakeGhostOpacity: Number.isFinite(Number(meta.stakeGhostOpacity))
                    ? Number(meta.stakeGhostOpacity)
                    : null,
            };
        });

        const batchMap = new Map();
        photoBatches.forEach(b => {
            batchMap.set(b.id, {
                id: b.id,
                name: b.name,
                createdAt: b.createdAt,
                organizationId: b.organizationId || currentOrgId,
                photoIds: []
            });
        });

        serverPhotos.forEach(p => {
            if (!p.batchId) {
                delete p.batchNameHint;
                return;
            }
            const bid = p.batchId;
            if (!batchMap.has(bid)) {
                const hint = p.batchNameHint && String(p.batchNameHint).trim();
                batchMap.set(bid, {
                    id: bid,
                    name: hint || null,
                    photoIds: [],
                    createdAt: p.createdAt || new Date().toISOString(),
                    organizationId: currentOrgId
                });
            } else {
                const hint = p.batchNameHint && String(p.batchNameHint).trim();
                if (hint) {
                    batchMap.get(bid).name = hint;
                }
            }
            batchMap.get(bid).photoIds.push(p.id);
            delete p.batchNameHint;
        });

        photoBatches = Array.from(batchMap.values()).filter(b => b.photoIds.length > 0);
        savePhotoBatches();

        // Replace current org's photos with server list; keep pending offline uploads for this org
        const otherOrgsPhotos = savedPhotos.filter(p => p.organizationId !== currentOrgId);
        let pendingLocal = [];
        if (window.offlineStore && typeof window.offlineStore.listPendingUploads === 'function') {
            try {
                const pending = await window.offlineStore.listPendingUploads();
                pendingLocal = pending
                    .filter((e) => Number(e.orgId) === Number(currentOrgId) && e.localPhotoRecord)
                    .map((e) => e.localPhotoRecord);
            } catch (_) { /* */ }
        }
        savedPhotos = otherOrgsPhotos.concat(serverPhotos).concat(pendingLocal);
        savePhotos();
        if (window.offlinePhotos && typeof window.offlinePhotos.persistPhotoMetaFromMemory === 'function') {
            await window.offlinePhotos.persistPhotoMetaFromMemory(currentOrgId);
        }
        if (window.photoMapLoaderModule && typeof window.photoMapLoaderModule.scheduleFetchPhotoMapForViewport === 'function') {
            window.photoMapLoaderModule.scheduleFetchPhotoMapForViewport(true);
        }
        if (window.refreshDataWindow) window.refreshDataWindow();
    } catch (error) {
        console.error('Error loading photos from server:', error);
    }
}

function invalidateManageDataPhotosSync() {
    manageDataPhotosSyncedOrgId = null;
}

/** Load local + GET /data/media for photos if not already synced for this org. Called on app startup, org change, and Manage Data → Photos. */
async function ensureManageDataPhotosLoaded() {
    const currentOrgId = resolveCurrentOrgId();
    if (!currentOrgId || !window.authModule || !window.authModule.isAuthenticated()) return;
    if (manageDataPhotosSyncedOrgId === currentOrgId) return;

    loadSavedPhotos();
    loadPhotoBatches();
    if (
        window.offlinePhotos &&
        typeof window.offlinePhotos.hydrateOfflinePendingPhotoPreviews === 'function'
    ) {
        await window.offlinePhotos.hydrateOfflinePendingPhotoPreviews(savedPhotos);
    }
    const offline = window.offlineModule && window.offlineModule.isOnline && !window.offlineModule.isOnline();
    if (offline) {
        if (window.offlinePhotos && typeof window.offlinePhotos.loadPhotoMetaIntoMemory === 'function') {
            const ok = await window.offlinePhotos.loadPhotoMetaIntoMemory(currentOrgId);
            if (ok) manageDataPhotosSyncedOrgId = currentOrgId;
        }
        return;
    }
    try {
        await loadPhotosFromServer();
        manageDataPhotosSyncedOrgId = currentOrgId;
    } catch (err) {
        if (window.offlinePhotos && typeof window.offlinePhotos.loadPhotoMetaIntoMemory === 'function') {
            const ok = await window.offlinePhotos.loadPhotoMetaIntoMemory(currentOrgId);
            if (ok) manageDataPhotosSyncedOrgId = currentOrgId;
        }
    }
}

// Load photo batches from localStorage (filtered by organization)
function loadPhotoBatches() {
    const currentOrgId = resolveCurrentOrgId();
    
    try {
        const stored = localStorage.getItem('photoBatches');
        if (stored) {
            const allBatches = JSON.parse(stored);
            // Filter by current organization
            photoBatches = allBatches.filter((batch) => photoOrgIdMatches(batch.organizationId, currentOrgId));
        }
    } catch (error) {
        console.error('Error loading photo batches:', error);
        photoBatches = [];
    }
}

// Save photo batches to localStorage (merge with other orgs' data)
function savePhotoBatches() {
    try {
        const currentOrgId = resolveCurrentOrgId();
        // Load all batches
        const stored = localStorage.getItem('photoBatches');
        let allBatches = stored ? JSON.parse(stored) : [];
        
        // Remove current org's batches and add updated ones
        allBatches = allBatches.filter((batch) => !photoOrgIdMatches(batch.organizationId, currentOrgId));
        // Add current org's batches with orgId
        const batchesWithOrgId = photoBatches.map(batch => ({
            ...batch,
            organizationId: currentOrgId
        }));
        allBatches = allBatches.concat(batchesWithOrgId);
        
        localStorage.setItem('photoBatches', JSON.stringify(allBatches));
    } catch (error) {
        console.error('Error saving photo batches:', error);
    }
}

// Helper function to get image URL from photo object (handles both old base64 and new backend file IDs)

function savePhotos() {
    try {
        const currentOrgId = resolveCurrentOrgId();
        // Don't save marker references to localStorage, and exclude base64 data URLs
        const photosToSave = savedPhotos.map(photo => {
            const photoData = {
                id: photo.id,
                latlng: photo.latlng,
                fileName: photo.fileName,
                originalFileName: photo.originalFileName || photo.fileName,
                exifData: photo.exifData,
                createdAt: photo.createdAt,
                batchId: photo.batchId,
                organizationId: photo.organizationId || currentOrgId
            };
            if (photo.ownerOrganizationId != null) {
                photoData.ownerOrganizationId = photo.ownerOrganizationId;
            }
            if (photo.shared) {
                photoData.shared = true;
                if (photo.sharedFromOrganizationId != null) {
                    photoData.sharedFromOrganizationId = photo.sharedFromOrganizationId;
                }
                if (photo.sharedSourceLabel) {
                    photoData.sharedSourceLabel = photo.sharedSourceLabel;
                }
            }
            
            // Only include fileId if it exists (new backend storage)
            if (photo.fileId) {
                photoData.fileId = photo.fileId;
            }
            if (photo.thumbnailUrl) {
                const thumb = String(photo.thumbnailUrl);
                if (!thumb.startsWith('blob:')) {
                    photoData.thumbnailUrl = photo.thumbnailUrl;
                }
            }
            
            // Only include imageUrl if it's NOT a base64 data URL (legacy support)
            // Base64 data URLs start with "data:"; blob previews are session-only.
            if (
                photo.imageUrl &&
                !photo.imageUrl.startsWith('data:') &&
                !photo.imageUrl.startsWith('blob:')
            ) {
                photoData.imageUrl = photo.imageUrl;
            }
            if (photo.offlineClientPhotoId) {
                photoData.offlineClientPhotoId = photo.offlineClientPhotoId;
            }
            if (photo.offlinePendingUpload) {
                photoData.offlinePendingUpload = true;
            }
            if (photo.note != null) {
                photoData.note = photo.note;
            }
            if (photo.uploadedBy) {
                photoData.uploadedBy = photo.uploadedBy;
            }
            if (photo.noteLastEditedBy) {
                photoData.noteLastEditedBy = photo.noteLastEditedBy;
            }
            if (photo.noteLastEditedAt) {
                photoData.noteLastEditedAt = photo.noteLastEditedAt;
            }
            if (photo.gpsLastEditedBy) {
                photoData.gpsLastEditedBy = photo.gpsLastEditedBy;
            }
            if (photo.gpsLastEditedAt) {
                photoData.gpsLastEditedAt = photo.gpsLastEditedAt;
            }
            if (photo.associatedTicketId != null && Number.isFinite(Number(photo.associatedTicketId))) {
                photoData.associatedTicketId = Number(photo.associatedTicketId);
            }
            if (photo.associationSource) {
                photoData.associationSource = photo.associationSource;
            }
            if (photo.associatedAt) {
                photoData.associatedAt = photo.associatedAt;
            }
            if (photo.hasWhitePaintMark) {
                photoData.hasWhitePaintMark = true;
            }
            if (photo.tags && photo.tags.length) {
                photoData.tags = photo.tags;
            }
            if (photo.dirtEventId) {
                photoData.dirtEventId = photo.dirtEventId;
            }
            if (photo.stakeOfPhotoId != null && Number.isFinite(Number(photo.stakeOfPhotoId))) {
                photoData.stakeOfPhotoId = Number(photo.stakeOfPhotoId);
            }
            if (photo.stakeGhostOpacity != null && Number.isFinite(Number(photo.stakeGhostOpacity))) {
                photoData.stakeGhostOpacity = Number(photo.stakeGhostOpacity);
            }
            
            return photoData;
        });
        
        // Load all photos
        const stored = localStorage.getItem('savedPhotos');
        let allPhotos = stored ? JSON.parse(stored) : [];
        
        // Remove current org's photos and add updated ones
        allPhotos = allPhotos.filter((photo) => !photoOrgIdMatches(photo.organizationId, currentOrgId));
        allPhotos = allPhotos.concat(photosToSave);
        
        localStorage.setItem('savedPhotos', JSON.stringify(allPhotos));
    } catch (error) {
        console.error('Error saving photos:', error);
        // If quota exceeded, try to clear old base64 photos and retry
        if (error.name === 'QuotaExceededError') {
            try {
                const stored = localStorage.getItem('savedPhotos');
                if (stored) {
                    const allPhotos = JSON.parse(stored);
                    // Remove photos with base64 data URLs
                    const cleanedPhotos = allPhotos.filter(photo => {
                        if (photo.imageUrl && photo.imageUrl.startsWith('data:')) {
                            return false; // Remove base64 photos
                        }
                        return true;
                    });
                    localStorage.setItem('savedPhotos', JSON.stringify(cleanedPhotos));
                    // Retry saving
                    savePhotos();
                }
            } catch (retryError) {
                console.error('Error during cleanup retry:', retryError);
            }
        }
    }
}
