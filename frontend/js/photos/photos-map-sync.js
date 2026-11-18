/**
 * photos-map-sync.js — split from photos-core.js (Phase F5).
 * Pending delete queue, place/move after GPS, photo detail modals.
 */
async function deleteMediaFileOnServer(fileId, orgId) {
    if (!window.authModule || !window.authModule.apiRequest) throw new Error('Not authenticated');
    const url =
        orgId != null
            ? `${window.authModule.API_BASE}/data/media/${fileId}?organizationId=${orgId}`
            : `${window.authModule.API_BASE}/data/media/${fileId}`;
    try {
        await window.authModule.apiRequest(url, { method: 'DELETE' });
    } catch (err) {
        if (err && err.status === 404) return;
        throw err;
    }
}

// Deletes that failed transiently (offline, 5xx) are queued here and retried on app
// resume / before the next server photo load, so the file doesn't linger in R2.
const PENDING_MEDIA_DELETES_KEY = 'pendingMediaDeletes';

function readPendingMediaDeletes() {
    try {
        const list = JSON.parse(localStorage.getItem(PENDING_MEDIA_DELETES_KEY) || '[]');
        return Array.isArray(list) ? list : [];
    } catch (_) {
        return [];
    }
}

function writePendingMediaDeletes(list) {
    try {
        if (!list || !list.length) localStorage.removeItem(PENDING_MEDIA_DELETES_KEY);
        else localStorage.setItem(PENDING_MEDIA_DELETES_KEY, JSON.stringify(list));
    } catch (_) { /* localStorage full/unavailable */ }
}

function enqueuePendingMediaDelete(fileId, orgId, photoId) {
    if (fileId == null) return;
    const list = readPendingMediaDeletes();
    if (list.some((e) => Number(e.fileId) === Number(fileId))) return;
    list.push({
        fileId: Number(fileId),
        orgId: orgId != null ? Number(orgId) : null,
        photoId: photoId != null ? String(photoId) : null,
    });
    writePendingMediaDeletes(list);
}

let pendingMediaDeletesFlushInFlight = null;

/** Retry queued media deletes. On success (or 404) removes the photo locally as well. */
function flushPendingMediaDeletes() {
    if (pendingMediaDeletesFlushInFlight) return pendingMediaDeletesFlushInFlight;
    pendingMediaDeletesFlushInFlight = (async () => {
        const list = readPendingMediaDeletes();
        if (!list.length) return;
        if (!window.authModule || !window.authModule.isAuthenticated()) return;
        const remaining = [];
        let removedAny = false;
        for (const entry of list) {
            try {
                await deleteMediaFileOnServer(entry.fileId, entry.orgId);
                const idx = savedPhotos.findIndex(
                    (p) =>
                        (entry.photoId != null && p.id === entry.photoId) ||
                        (p.fileId != null && Number(p.fileId) === Number(entry.fileId))
                );
                if (idx >= 0) {
                    savedPhotos.splice(idx, 1);
                    evictPhotoBlobCachesForFile(entry.fileId);
                    removedAny = true;
                }
            } catch (err) {
                console.warn('[photos] pending delete retry failed:', err.message || err);
                remaining.push(entry);
            }
        }
        writePendingMediaDeletes(remaining);
        if (removedAny) {
            savePhotos();
            if (window.photoMapLoaderModule && typeof window.photoMapLoaderModule.invalidatePhotoMapCache === 'function') {
                window.photoMapLoaderModule.invalidatePhotoMapCache();
            }
            reloadPhotosOnMap();
            if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
                window.dataTableRendererModule.renderDataTable();
            }
            if (window.ticketsModule && typeof window.ticketsModule.refreshTicketUiAfterPhotoChange === 'function') {
                window.ticketsModule.refreshTicketUiAfterPhotoChange(null, 'photo-delete');
            }
        }
    })().finally(() => {
        pendingMediaDeletesFlushInFlight = null;
    });
    return pendingMediaDeletesFlushInFlight;
}

function refreshPhotoMarkerPopup(photo) {
    if (!photo || !photo.marker) return;
    photo.marker.setPopupContent(buildPhotoMapPopupHtml(photo));
}

function placeOrMovePhotoMarker(photo, latlng) {
    const map = window.map;
    if (!map || !photo || !latlng) return null;

    // Remove any existing pin for this photo id or fileId (viewport uses map-photo-{fileId}).
    const existing = findPhotoMapMarker(photo);
    if (existing) detachPhotoMapMarkerFromMap(existing);
    if (photo.fileId != null) {
        const extras = [];
        forEachPhotoMapLayer(function (m) {
            if (m && m.options && photoFileIdsMatch(m.options.fileId, photo.fileId)) extras.push(m);
        });
        extras.forEach(detachPhotoMapMarkerFromMap);
    }
    clearPhotoMarkerRefsForPhoto(photo);

    // Prefer attaching the marker to the viewport stub when present so reloadPhotosOnMap stays consistent.
    let renderPhoto = photo;
    const loader = window.photoMapLoaderModule;
    if (loader && typeof loader.getMapViewportPhotos === 'function' && photo.fileId != null) {
        const vp = (loader.getMapViewportPhotos() || []).find((p) => p && photoFileIdsMatch(p.fileId, photo.fileId));
        if (vp) {
            vp.latlng = { lat: Number(latlng.lat), lng: Number(latlng.lng) };
            renderPhoto = vp;
        }
    }

    if (!photoPassesRecentWindow(renderPhoto)) {
        return null;
    }

    const photoIcon = L.divIcon({
        className: getPhotoMapMarkerClassName(renderPhoto),
        html: getPhotoMapMarkerIconHtml(renderPhoto),
        iconSize: [32, 32],
        iconAnchor: [16, 32],
        popupAnchor: [0, -32],
    });

    const marker = L.marker(latlng, {
        icon: photoIcon,
        photoId: renderPhoto.id,
        fileId: renderPhoto.fileId != null ? renderPhoto.fileId : photo.fileId != null ? photo.fileId : null,
    });
    const pointLayer = getPhotosPointMarkerLayer();
    if (pointLayer) {
        marker.addTo(pointLayer);
    } else {
        marker.addTo(map);
    }

    const popupHtml = buildPhotoMapPopupHtml(renderPhoto);
    marker.bindPopup(popupHtml || '<div class="photo-popup">Photo</div>', { autoPan: false });
    marker.on('popupopen', function () {
        const el = this.getPopup().getElement();
        if (el && setServerPhotoImageSources) setServerPhotoImageSources(el);
        if (el && bindPhotoPopupNoteButton) bindPhotoPopupNoteButton(el);
        if (centerMapOnPhotoPopup) centerMapOnPhotoPopup(this);
    });
    wirePhotoMapMarkerLeafletMobile(marker);
    renderPhoto.marker = marker;
    if (renderPhoto !== photo) photo.marker = marker;
    return marker;
}

async function patchPhotoDetailsOnServer(fileId, details) {
    if (!fileId || !window.authModule || !window.authModule.isAuthenticated()) {
        throw new Error('Not authenticated or missing file id');
    }
    const base = window.authModule.API_BASE;
    const orgId = resolveCurrentOrgId();
    const url = `${base}/data/media/${fileId}${orgId != null ? `?organizationId=${encodeURIComponent(String(orgId))}` : ''}`;
    const headers = Object.assign(
        { 'Content-Type': 'application/json' },
        (window.authModule.getAuthHeaders && window.authModule.getAuthHeaders()) || {}
    );
    const body = {};
    if (details && Object.prototype.hasOwnProperty.call(details, 'note')) {
        body.note = details.note == null ? '' : String(details.note);
    }
    if (details && Object.prototype.hasOwnProperty.call(details, 'tags')) {
        const tagMod = window.photoTagsModule;
        body.tags =
            tagMod && typeof tagMod.normalizePhotoTags === 'function'
                ? tagMod.normalizePhotoTags(details.tags)
                : details.tags;
    }
    const response = await fetch(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body)
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || response.statusText || 'Failed to save photo details');
    }
    return response.json().catch(() => ({}));
}

async function patchPhotoNoteOnServer(fileId, note) {
    return patchPhotoDetailsOnServer(fileId, { note: note });
}

function applyPhotoDetailsMetadataToLocalPhoto(photo, metadata) {
    if (!photo || !metadata || typeof metadata !== 'object') return;
    if (typeof metadata.note === 'string') photo.note = metadata.note;
    if (typeof metadata.noteLastEditedBy === 'string') photo.noteLastEditedBy = metadata.noteLastEditedBy;
    if (typeof metadata.noteLastEditedAt === 'string') photo.noteLastEditedAt = metadata.noteLastEditedAt;
    const tagMod = window.photoTagsModule;
    if (Array.isArray(metadata.tags)) {
        photo.tags = tagMod && typeof tagMod.normalizePhotoTags === 'function'
            ? tagMod.normalizePhotoTags(metadata.tags)
            : metadata.tags;
    }
    if (metadata.hasWhitePaintMark === true) {
        photo.hasWhitePaintMark = true;
        if (!photo.exifData || typeof photo.exifData !== 'object') photo.exifData = {};
        photo.exifData.hasWhitePaintMark = true;
    } else if (metadata.hasWhitePaintMark === false) {
        photo.hasWhitePaintMark = false;
        if (photo.exifData && typeof photo.exifData === 'object') photo.exifData.hasWhitePaintMark = false;
    } else if (tagMod && typeof tagMod.photoTagsIncludeWhitePaint === 'function') {
        const on = tagMod.photoTagsIncludeWhitePaint(photo.tags);
        photo.hasWhitePaintMark = on;
        if (!photo.exifData || typeof photo.exifData !== 'object') photo.exifData = {};
        photo.exifData.hasWhitePaintMark = on;
    }
    if (window.photoStakeUtils && typeof window.photoStakeUtils.applyStakeFieldsFromMeta === 'function') {
        window.photoStakeUtils.applyStakeFieldsFromMeta(photo, metadata);
        const stakeId = window.photoStakeUtils.getPhotoStakeOfPhotoId(photo);
        if (stakeId != null) {
            if (!photo.exifData || typeof photo.exifData !== 'object') photo.exifData = {};
            photo.exifData.stakeOfPhotoId = stakeId;
        }
    }
}

function refreshPhotoDetailsUi(photo) {
    if (!photo) return;
    const marker = photo.marker || findPhotoMapMarker(photo);
    if (marker) {
        // Prefer the object that owns the marker for popup fields when ids differ
        // (map-photo-* viewport vs photo-server-* manage-data copy).
        let popupPhoto = photo;
        if (marker.options && marker.options.photoId != null && String(marker.options.photoId) !== String(photo.id)) {
            const owner = findPhotoForUi(marker.options.photoId);
            if (owner) {
                owner.note = photo.note;
                owner.tags = photo.tags;
                if (photo.noteLastEditedBy != null) owner.noteLastEditedBy = photo.noteLastEditedBy;
                if (photo.noteLastEditedAt != null) owner.noteLastEditedAt = photo.noteLastEditedAt;
                if (photo.hasWhitePaintMark != null) owner.hasWhitePaintMark = photo.hasWhitePaintMark;
                if (photo.exifData) owner.exifData = photo.exifData;
                popupPhoto = owner;
            }
        }
        marker.setPopupContent(buildPhotoMapPopupHtml(popupPhoto));
        // If the popup is open right now, setPopupContent replaced its DOM: re-bind
        // handlers and reload the tokenized image so the popup updates in place.
        const popup = typeof marker.getPopup === 'function' ? marker.getPopup() : null;
        const popupEl = popup && typeof popup.getElement === 'function' ? popup.getElement() : null;
        if (popupEl) {
            setServerPhotoImageSources(popupEl);
            bindPhotoPopupNoteButton(popupEl);
        }
        photo.marker = marker;
        if (popupPhoto !== photo) popupPhoto.marker = marker;
    }
    const infoModal = document.getElementById('photoMapInfoModal');
    if (infoModal && infoModal.classList.contains('show')) {
        const openId = infoModal.dataset.photoId;
        const same =
            openId &&
            (String(openId) === String(photo.id) ||
                (photo.fileId != null &&
                    (String(openId) === `map-photo-${photo.fileId}` ||
                        String(openId) === `photo-server-${photo.fileId}`)));
        if (same) openPhotoMapInfoModal(photo.id);
    }
    const viewerModal = document.getElementById('photoViewerModal');
    if (
        viewerModal &&
        viewerModal.classList.contains('show') &&
        typeof window.syncPhotoViewerTagsBar === 'function'
    ) {
        const viewerId = viewerModal.dataset.currentPhotoId;
        const sameViewer =
            viewerId &&
            (String(viewerId) === String(photo.id) ||
                (photo.fileId != null &&
                    (String(viewerId) === `map-photo-${photo.fileId}` ||
                        String(viewerId) === `photo-server-${photo.fileId}`)));
        if (sameViewer) window.syncPhotoViewerTagsBar(photo);
    }
    if (typeof window.refreshManageDataRowInfoForPhoto === 'function') {
        window.refreshManageDataRowInfoForPhoto(photo);
    }
    if (window.refreshDataWindow) window.refreshDataWindow();
}


let photoDetailsEditVocabulary = [];
let photoDetailsEditPhotoId = null;

function closePhotoDetailsEditModal() {
    const modal = document.getElementById('photoDetailsEditModal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    // Keep scroll locked if the fullscreen photo viewer is still open underneath
    const viewerModal = document.getElementById('photoViewerModal');
    document.body.style.overflow = viewerModal && viewerModal.classList.contains('show') ? 'hidden' : '';
    photoDetailsEditPhotoId = null;
}

function wirePhotoDetailsEditModalOnce() {
    const modal = document.getElementById('photoDetailsEditModal');
    if (!modal || modal.dataset.wired === '1') return;
    modal.dataset.wired = '1';

    const closeBtn = document.getElementById('photoDetailsEditModalClose');
    const cancelBtn = document.getElementById('photoDetailsEditCancelBtn');
    const saveBtn = document.getElementById('photoDetailsEditSaveBtn');
    const noteEl = document.getElementById('photoDetailsEditNote');
    const tagsEl = document.getElementById('photoDetailsEditTags');
    const quickPick = document.getElementById('photoDetailsEditTagQuickPick');

    if (tagsEl && typeof bindPhotoTagSuggestInput === 'function') {
        bindPhotoTagSuggestInput(tagsEl, {
            getVocabulary: function () { return photoDetailsEditVocabulary; },
            getExcludeTags: function () {
                const mod = window.photoTagsModule;
                if (!mod) return [];
                return mod.normalizePhotoTags(String(tagsEl.value || '').replace(/,\s*$/, ''));
            }
        });
    }
    if (quickPick && tagsEl && typeof bindPhotoTagQuickPickChips === 'function') {
        bindPhotoTagQuickPickChips(quickPick, tagsEl);
    }

    function onCancel() {
        closePhotoDetailsEditModal();
    }

    if (closeBtn) closeBtn.addEventListener('click', onCancel);
    if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', function (ev) {
        if (ev.target === modal) onCancel();
    });

    if (saveBtn) {
        saveBtn.addEventListener('click', async function () {
            const photoId = photoDetailsEditPhotoId;
            const photo = findPhotoForUi(photoId);
            if (!photo || !noteEl || !tagsEl) return;
            const tagMod = window.photoTagsModule;
            const nextNote = noteEl.value;
            const nextTags = tagMod && typeof tagMod.normalizePhotoTags === 'function'
                ? tagMod.normalizePhotoTags(tagsEl.value)
                : String(tagsEl.value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);

            saveBtn.disabled = true;
            try {
                let uiPhoto = photo;
                if (photo.fileId) {
                    const data = await patchPhotoDetailsOnServer(photo.fileId, { note: nextNote, tags: nextTags });
                    const fields = { note: nextNote, tags: nextTags };
                    if (data && data.metadata) {
                        applyPhotoDetailsMetadataToLocalPhoto(photo, data.metadata);
                        if (typeof data.metadata.note === 'string') fields.note = data.metadata.note;
                        if (Array.isArray(data.metadata.tags)) fields.tags = data.metadata.tags;
                        if (typeof data.metadata.noteLastEditedBy === 'string') {
                            fields.noteLastEditedBy = data.metadata.noteLastEditedBy;
                        }
                        if (typeof data.metadata.noteLastEditedAt === 'string') {
                            fields.noteLastEditedAt = data.metadata.noteLastEditedAt;
                        }
                        if (data.metadata.hasWhitePaintMark === true || data.metadata.hasWhitePaintMark === false) {
                            fields.hasWhitePaintMark = data.metadata.hasWhitePaintMark;
                        }
                    } else if (tagMod && typeof tagMod.photoTagsIncludeWhitePaint === 'function') {
                        fields.hasWhitePaintMark = tagMod.photoTagsIncludeWhitePaint(nextTags);
                    }
                    uiPhoto = syncPhotoDetailsAcrossLocalCopies(photo.fileId, fields, photo) || photo;
                    const orgId = resolveCurrentOrgId();
                    if (tagMod && typeof tagMod.invalidateOrgPhotoTagVocabulary === 'function') {
                        tagMod.invalidateOrgPhotoTagVocabulary(orgId);
                    }
                } else {
                    photo.note = nextNote;
                    photo.tags = nextTags;
                    const who = resolveCurrentUserDisplayName();
                    if (who) photo.noteLastEditedBy = who;
                    photo.noteLastEditedAt = new Date().toISOString();
                    if (tagMod && typeof tagMod.photoTagsIncludeWhitePaint === 'function') {
                        photo.hasWhitePaintMark = tagMod.photoTagsIncludeWhitePaint(nextTags);
                        if (!photo.exifData || typeof photo.exifData !== 'object') photo.exifData = {};
                        photo.exifData.hasWhitePaintMark = photo.hasWhitePaintMark;
                    }
                }
                savePhotos();
                refreshPhotoDetailsUi(uiPhoto);
                closePhotoDetailsEditModal();
            } catch (err) {
                console.error(err);
                void appAlert(err.message || 'Could not save photo details');
            } finally {
                saveBtn.disabled = false;
            }
        });
    }

    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        if (!modal.classList.contains('show')) return;
        closePhotoDetailsEditModal();
    });
}

async function promptEditPhotoDetails(photoId) {
    const photo = findPhotoForUi(photoId);
    if (!photo || photo.readOnly) return;
    wirePhotoDetailsEditModalOnce();

    const modal = document.getElementById('photoDetailsEditModal');
    const noteEl = document.getElementById('photoDetailsEditNote');
    const tagsEl = document.getElementById('photoDetailsEditTags');
    if (!modal || !noteEl || !tagsEl) {
        return promptEditPhotoNoteLegacy(photoId);
    }

    const tagMod = window.photoTagsModule;
    const orgId = resolveCurrentOrgId();
    photoDetailsEditVocabulary =
        tagMod && typeof tagMod.fetchOrgPhotoTagVocabulary === 'function'
            ? await tagMod.fetchOrgPhotoTagVocabulary(orgId)
            : [];
    // Prefer resolved id so save/find stay consistent across map-photo vs photo-server ids
    photoDetailsEditPhotoId = photo.id != null ? photo.id : photoId;

    noteEl.value = photo.note != null ? String(photo.note) : '';
    const tags = tagMod && typeof tagMod.getPhotoTags === 'function' ? tagMod.getPhotoTags(photo) : [];
    tagsEl.value =
        tagMod && typeof tagMod.formatPhotoTagsForInput === 'function'
            ? tagMod.formatPhotoTagsForInput(tags)
            : tags.join(', ');

    // Photo viewer modal is z-index 110000; raise edit modal above it when opened from fullscreen
    const viewerModal = document.getElementById('photoViewerModal');
    modal.style.zIndex = viewerModal && viewerModal.classList.contains('show') ? '111000' : '63000';
    modal.style.display = 'flex';
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    noteEl.focus();
}

async function promptEditPhotoNoteLegacy(photoId) {
    const photo = findPhotoForUi(photoId);
    if (!photo) return;
    const current = photo.note != null ? String(photo.note) : '';
    const next = await appPrompt('Photo note:', current, { title: 'Photo note', multiline: true });
    if (next === null) return;
    if (photo.fileId) {
        patchPhotoNoteOnServer(photo.fileId, next).then(function (data) {
            const fields = { note: next };
            if (data && data.metadata) {
                applyPhotoDetailsMetadataToLocalPhoto(photo, data.metadata);
                if (typeof data.metadata.note === 'string') fields.note = data.metadata.note;
                if (typeof data.metadata.noteLastEditedBy === 'string') {
                    fields.noteLastEditedBy = data.metadata.noteLastEditedBy;
                }
                if (typeof data.metadata.noteLastEditedAt === 'string') {
                    fields.noteLastEditedAt = data.metadata.noteLastEditedAt;
                }
            }
            const uiPhoto = syncPhotoDetailsAcrossLocalCopies(photo.fileId, fields, photo) || photo;
            savePhotos();
            refreshPhotoDetailsUi(uiPhoto);
        }).catch(function (err) {
            console.error(err);
            appAlert(err.message || 'Could not save note');
        });
    } else {
        photo.note = next;
        const who = resolveCurrentUserDisplayName();
        if (who) photo.noteLastEditedBy = who;
        photo.noteLastEditedAt = new Date().toISOString();
        savePhotos();
        refreshPhotoDetailsUi(photo);
    }
}

async function promptEditPhotoNote(photoId) {
    return promptEditPhotoDetails(photoId);
}

/** Legacy auto titles from older clients; treat like no custom name so UI shows date + count. */
function isLegacyAutogeneratedPhotoBatchName(name) {
    if (name == null || name === '') return false;
    return /^Photo Upload - /i.test(String(name).trim());
}

/** Primary label before the "(N photos)" suffix — custom name or batch created date. */
function getPhotoBatchDisplayPrimaryLabel(batch) {
    if (!batch) return '';
    const n = batch.name != null ? String(batch.name).trim() : '';
    if (n && !isLegacyAutogeneratedPhotoBatchName(n)) return n;
    return window.formatRecordedDateTime(batch.createdAt) || '';
}

/** Sort key for Manage Data name column: named batches by name; others by createdAt. */
function getPhotoBatchNameSortKey(batch) {
    if (!batch) return '';
    const n = batch.name != null ? String(batch.name).trim() : '';
    if (n && !isLegacyAutogeneratedPhotoBatchName(n)) return n.toLowerCase();
    const t = batch.createdAt ? new Date(batch.createdAt).getTime() : 0;
    return String(t).padStart(15, '0');
}

async function patchPhotoBatchNameOnServer(fileId, batchName) {
    if (!fileId || !window.authModule || !window.authModule.isAuthenticated()) {
        throw new Error('Not authenticated or missing file id');
    }
    const orgId = resolveCurrentOrgId();
    const url = `${window.authModule.API_BASE}/data/media/${fileId}${orgId != null ? `?organizationId=${encodeURIComponent(String(orgId))}` : ''}`;
    const headers = Object.assign(
        { 'Content-Type': 'application/json' },
        (window.authModule.getAuthHeaders && window.authModule.getAuthHeaders()) || {}
    );
    const response = await fetch(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ batchName: batchName == null ? '' : String(batchName) })
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || response.statusText || 'Failed to save batch name');
    }
    return response.json().catch(() => ({}));
}

async function renamePhotoBatch(batchId) {
    const batch = photoBatches.find(b => b.id === batchId);
    if (!batch) return;
    const next = await appPrompt('Batch name:', getPhotoBatchDisplayPrimaryLabel(batch), { title: 'Rename photo batch' });
    if (next === null) return;
    const trimmed = String(next).trim();
    if (trimmed === '') return;
    batch.name = trimmed;
    savePhotoBatches();
    const photosInBatch = savedPhotos.filter(p => p.batchId === batchId && p.fileId);
    // Parallelize — same per-file PATCH API as before, without waiting sequentially.
    await Promise.allSettled(
        photosInBatch.map((p) =>
            patchPhotoBatchNameOnServer(p.fileId, trimmed).catch((e) => {
                console.error('Could not sync batch name to server:', e);
            })
        )
    );
    if (window.refreshDataWindow) window.refreshDataWindow();
}

/** True if this media row points at a generated JPEG thumbnail file (not the original upload). */
function isThumbnailStorageFile(file) {
    const fp = file && file.filePath != null ? String(file.filePath).replace(/\\/g, '/').toLowerCase() : '';
    const fn = file && file.fileName != null ? String(file.fileName).toLowerCase() : '';
    return fp.endsWith('_thumb.jpg') || fn.endsWith('_thumb.jpg');
}

// Load photos from server for the current organization (so Data tab shows org's photos)
function canAdminPhotoPublicFlag() {
    const orgId = typeof window.getCurrentOrgId === 'function' ? window.getCurrentOrgId() : null;
    if (!orgId || !window.authModule) return false;
    if (window.authModule.isDev()) return true;
    const user = window.authModule.getCurrentUser();
    return Array.isArray(user && user.adminOrganizationIds) && user.adminOrganizationIds.includes(orgId);
}

async function setPhotoPublicFlag(fileId, isPublic) {
    if (!canAdminPhotoPublicFlag()) {
        throw new Error('Only organization admins can change public photo sharing.');
    }
    const orgId = window.getCurrentOrgId();
    await window.authModule.apiRequest(`${window.authModule.API_BASE}/data/media/${fileId}/public`, {
        method: 'PATCH',
        body: JSON.stringify({ organizationId: orgId, isPublic: !!isPublic }),
    });
    const photo = savedPhotos.find((p) => Number(p.fileId) === Number(fileId));
    if (photo) photo.isPublic = !!isPublic;
}

