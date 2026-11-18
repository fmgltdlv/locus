/**
 * photos-core.js — split from photos-core.js (Phase F5).
 * Module state, upload consts/toasts, map markers, GPS patch helpers.
 */
// Photo upload module

// Photo upload mode
let photoUploadMode = false;
let photoUploadHandler = null;

/** Manage Data: user is picking a map point for a photo without GPS. */
let photoLocationTagMode = false;
let photoLocationTagClickHandler = null;

function syncTicketLayersForPhotoMapTool() {
    if (window.ticketsModule && typeof window.ticketsModule.syncTicketLayerPointerInteraction === 'function') {
        window.ticketsModule.syncTicketLayerPointerInteraction();
    }
}

function setPhotoLocationTagMode(active) {
    photoLocationTagMode = !!active;
    syncTicketLayersForPhotoMapTool();
}

function cancelPhotoLocationTag() {
    const map = window.map;
    if (photoLocationTagClickHandler && map) {
        map.off('click', photoLocationTagClickHandler);
        photoLocationTagClickHandler = null;
    }
    if (map) {
        map.getContainer().style.cursor = '';
    }
    setPhotoLocationTagMode(false);
}

/** Register map click handler for manual photo GPS tagging; replaces any prior session. */
function startPhotoLocationTagClick(handler) {
    cancelPhotoLocationTag();
    const map = window.map;
    if (!map || typeof handler !== 'function') return;
    photoLocationTagClickHandler = handler;
    setPhotoLocationTagMode(true);
    map.getContainer().style.cursor = 'crosshair';
    map.on('click', handler);
}

/** Tear down manual photo GPS tagging after success, cancel, or replace. */
function finishPhotoLocationTagClick(handler) {
    const map = window.map;
    if (handler && photoLocationTagClickHandler === handler && map) {
        map.off('click', handler);
    }
    photoLocationTagClickHandler = null;
    setPhotoLocationTagMode(false);
    if (map) {
        map.getContainer().style.cursor = '';
    }
}

// Stored photos array
let savedPhotos = [];

// Photo batches - groups of photos uploaded together
let photoBatches = [];

// Current upload batch ID (for grouping photos uploaded together)
let currentBatchId = null;

// Photos layer group (parent on map); point markers and server clusters live in child layers.
let photosLayerGroup = null;
let photosMarkerClusterGroup = null;
let photosServerClusterLayer = null;
let pendingClusterDrawer = null;
let photosClusterDrawerZoomBound = false;

/** Photo markers are only attached to the map at this zoom level or higher (reduces icon load when zoomed out). */
const PHOTO_MARKERS_MIN_ZOOM = 16;
/** Zoom at which coincident stacks get a badge marker and cluster clicks open the gallery drawer. */
const PHOTO_CLUSTER_DRAWER_ZOOM = 20;
/** ~3 m — photos closer than this at drawer zoom render as one stack badge (spiderfy replacement). */
const PHOTO_COINCIDENT_STACK_EPSILON = 0.00003;

/** User intent from the Photos overlay checkbox: show markers when zoom allows (independent of current map zoom). */
let photosLayerUserEnabled = true;

let photosZoomListenerBound = false;

/** Per org: skip duplicate GET /data/media?type=photo after a successful eager or tab-driven sync. */
let manageDataPhotosSyncedOrgId = null;

const PHOTO_MAP_MARKER_ICON_SIZE = 18;

function getPhotoMapMarkerIconInnerHtml() {
    const icons = window.mapIcons;
    if (icons && typeof icons.camera === 'function') {
        return icons.camera(PHOTO_MAP_MARKER_ICON_SIZE);
    }
    return '📷';
}

function photoMarkerShowsNoGpsBadge(photo) {
    return !!(photo && photo.associatedNoGps);
}

function getPhotoMapMarkerIconHtml(photo) {
    const badge = photoMarkerShowsNoGpsBadge(photo)
        ? '<span class="photo-marker-no-gps-badge" title="No GPS — placed at ticket area" aria-label="No GPS location">' +
          (window.mapIcons && typeof window.mapIcons.locationOff === 'function'
              ? window.mapIcons.locationOff(10)
              : '⊘') +
          '</span>'
        : '';
    return (
        '<div class="photo-marker-container">' +
        '<div class="photo-marker-icon">' +
        getPhotoMapMarkerIconInnerHtml() +
        '</div>' +
        badge +
        '</div>'
    );
}

function getPhotoMapMarkerClassName(photo) {
    return 'photo-marker' + (photoMarkerShowsNoGpsBadge(photo) ? ' photo-marker--associated-nogps' : '');
}

/** Match backend multer limit (`backend/routes/data.js`). */
const PHOTO_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/** Initial max longer edge (px) when re-encoding; reduced if the JPEG is still over the byte cap. */
const PHOTO_CLIENT_MAX_EDGE_PX_START = 3000;
/** Mobile: max images per picker batch (memory, stability). */
const PHOTO_MOBILE_MAX_FILES_PER_PICK = 25;

// Upload status: track current batch total for progress
let photoUploadStatusTotal = 0;
let photoUploadStatusHideTimer = null;

function showPhotoUploadStatus(total, currentOneBased, finishedCount) {
    photoUploadStatusTotal = total;
    const el = document.getElementById('photoUploadStatus');
    const textEl = el ? el.querySelector('.photo-upload-status-text') : null;
    if (!el || !textEl) return;
    el.className = 'photo-upload-status';
    el.style.display = 'flex';
    const n = Math.min(Math.max(currentOneBased, 1), total);
    const done =
        finishedCount != null ? Math.max(0, Math.min(finishedCount, total)) : Math.max(0, n - 1);
    const left = Math.max(0, total - done);
    if (total === 1) {
        textEl.textContent = 'Uploading photo…';
    } else if (left <= 1) {
        textEl.textContent = `Uploading photo ${n} of ${total}…`;
    } else {
        textEl.textContent = `Uploading photo ${n} of ${total} (${left} left)…`;
    }
    if (photoUploadStatusHideTimer) {
        clearTimeout(photoUploadStatusHideTimer);
        photoUploadStatusHideTimer = null;
    }
}

function showPhotoUploadPreparing(count) {
    const el = document.getElementById('photoUploadStatus');
    const textEl = el ? el.querySelector('.photo-upload-status-text') : null;
    if (!el || !textEl) return;
    const n = Math.max(1, Number(count) || 1);
    el.className = 'photo-upload-status';
    el.style.display = 'flex';
    textEl.textContent = n === 1 ? 'Preparing photo…' : `Preparing ${n} photos…`;
    if (photoUploadStatusHideTimer) {
        clearTimeout(photoUploadStatusHideTimer);
        photoUploadStatusHideTimer = null;
    }
}

let photoHeicConvertBatchTotal = 0;
let photoHeicConvertBatchDone = 0;

/** Count HEIC/HEIF files in this upload batch so conversion UI can show X/N progress. */
function beginPhotoHeicConversionBatch(total) {
    photoHeicConvertBatchTotal = Math.max(0, Number(total) || 0);
    photoHeicConvertBatchDone = 0;
}

function endPhotoHeicConversionBatch() {
    photoHeicConvertBatchTotal = 0;
    photoHeicConvertBatchDone = 0;
}

function markPhotoHeicConverted() {
    photoHeicConvertBatchDone = Math.min(
        photoHeicConvertBatchDone + 1,
        Math.max(photoHeicConvertBatchTotal, 0)
    );
}

/**
 * Show HEIC conversion progress in the upload banner.
 * @param {number} [completed] already converted in this batch
 * @param {number} [total] HEIC files in this batch (0/1 = single generic message)
 * @param {'active'|'done'} [phase] active = working on next; done = show X/N converted
 * Returns previous banner state so callers can restore it afterwards.
 */
function showPhotoUploadConverting(completed, total, phase) {
    const el = document.getElementById('photoUploadStatus');
    const textEl = el ? el.querySelector('.photo-upload-status-text') : null;
    if (!el || !textEl) return null;
    const prev = { className: el.className, display: el.style.display, text: textEl.textContent };
    el.className = 'photo-upload-status';
    el.style.display = 'flex';
    const done = Math.max(0, Number(completed) || 0);
    const n = Math.max(0, Number(total) || 0);
    if (n <= 1) {
        textEl.textContent = 'Converting photo...';
    } else if (phase === 'done') {
        textEl.textContent = `${done}/${n} photos converted`;
    } else {
        textEl.textContent = `Converting photo ${done + 1} of ${n}... (${done}/${n} converted)`;
    }
    if (photoUploadStatusHideTimer) {
        clearTimeout(photoUploadStatusHideTimer);
        photoUploadStatusHideTimer = null;
    }
    return prev;
}

function restorePhotoUploadStatusAfterConverting(prev) {
    const el = document.getElementById('photoUploadStatus');
    const textEl = el ? el.querySelector('.photo-upload-status-text') : null;
    if (!el || !textEl || !prev) return;
    el.className = prev.className;
    el.style.display = prev.display;
    textEl.textContent = prev.text;
}

function showPhotoUploadSuccess(total, noGpsCount) {
    const el = document.getElementById('photoUploadStatus');
    const textEl = el ? el.querySelector('.photo-upload-status-text') : null;
    if (!el || !textEl) return;
    el.className = 'photo-upload-status photo-upload-status-success';
    let msg = total === 1 ? '1 photo uploaded' : `${total} photos uploaded`;
    // Photos without GPS get no map marker, which looks like a failed upload; say where they went
    const noGps = Number(noGpsCount) || 0;
    if (noGps > 0) {
        msg +=
            noGps === total
                ? ' (no location found - see Manage Data)'
                : ` (${noGps} without location - see Manage Data)`;
    }
    textEl.textContent = msg;
    photoUploadStatusHideTimer = setTimeout(() => {
        el.style.display = 'none';
        photoUploadStatusHideTimer = null;
    }, noGps > 0 ? 6000 : 3000);
}

function showPhotoUploadError(message) {
    const el = document.getElementById('photoUploadStatus');
    const textEl = el ? el.querySelector('.photo-upload-status-text') : null;
    if (!el || !textEl) return;
    el.className = 'photo-upload-status photo-upload-status-error';
    textEl.textContent = message ? `Upload failed: ${message}` : 'Upload failed';
    photoUploadStatusHideTimer = setTimeout(() => {
        el.style.display = 'none';
        photoUploadStatusHideTimer = null;
    }, 5000);
}

function hidePhotoUploadStatus() {
    const el = document.getElementById('photoUploadStatus');
    if (el) el.style.display = 'none';
    if (photoUploadStatusHideTimer) {
        clearTimeout(photoUploadStatusHideTimer);
        photoUploadStatusHideTimer = null;
    }
}

function truncateMapUploadFileName(name) {
    const n = String(name || '');
    return n.length > 32 ? n.slice(0, 29) + '…' : n;
}

let documentUploadActive = { inFlight: 0, success: 0, currentName: '' };

function showDocumentUploadStatus() {
    const el = document.getElementById('photoUploadStatus');
    const textEl = el ? el.querySelector('.photo-upload-status-text') : null;
    if (!el || !textEl) return;
    const track = documentUploadActive;
    const shortName = truncateMapUploadFileName(track.currentName);
    let msg;
    if (shortName) {
        msg = `Uploading document: ${shortName}…`;
        if (track.inFlight > 1) msg += ` (${track.inFlight} in progress)`;
    } else if (track.inFlight > 1) {
        msg = `Uploading documents… (${track.inFlight} in progress)`;
    } else {
        msg = 'Uploading document…';
    }
    el.className = 'photo-upload-status';
    el.style.display = 'flex';
    textEl.textContent = msg;
    if (photoUploadStatusHideTimer) {
        clearTimeout(photoUploadStatusHideTimer);
        photoUploadStatusHideTimer = null;
    }
}

function startDocumentUpload(file) {
    documentUploadActive.inFlight++;
    documentUploadActive.currentName = file && file.name ? file.name : '';
    showDocumentUploadStatus();
}

function finishDocumentUpload(success) {
    documentUploadActive.inFlight = Math.max(0, documentUploadActive.inFlight - 1);
    if (success) documentUploadActive.success++;
    if (documentUploadActive.inFlight > 0) {
        showDocumentUploadStatus();
        return;
    }
    const uploaded = documentUploadActive.success;
    documentUploadActive = { inFlight: 0, success: 0, currentName: '' };
    if (uploaded > 0) {
        const el = document.getElementById('photoUploadStatus');
        const textEl = el ? el.querySelector('.photo-upload-status-text') : null;
        if (el && textEl) {
            el.className = 'photo-upload-status photo-upload-status-success';
            el.style.display = 'flex';
            textEl.textContent = uploaded === 1 ? '1 document uploaded' : `${uploaded} documents uploaded`;
            photoUploadStatusHideTimer = setTimeout(function () {
                el.style.display = 'none';
                photoUploadStatusHideTimer = null;
            }, 3000);
        }
    } else {
        hidePhotoUploadStatus();
    }
}

window.mapUploadStatusModule = {
    startDocumentUpload: startDocumentUpload,
    finishDocumentUpload: finishDocumentUpload,
    showPhotoUploadPreparing: showPhotoUploadPreparing,
};

/** Upload progress footer for in-page camera: successful uploads vs backlog (queued + in flight). */
function showInPageCameraUploadProgress(nUploaded, nQueuedIncludingActive) {
    const nOk = Math.max(0, Math.floor(Number(nUploaded) || 0));
    const m = Math.max(0, Math.floor(Number(nQueuedIncludingActive) || 0));
    const textEl = document.getElementById('inPageCameraUploadProgress');
    if (!textEl) return;
    if (typeof window.t === 'function') {
        textEl.textContent = window.t('{nUploaded} uploaded / {nQueued} queued', {
            nUploaded: nOk,
            nQueued: m
        });
    } else {
        textEl.textContent = `${nOk} uploaded / ${m} queued`;
    }
}

// Helper: resolve current org ID (call org selector's getCurrentOrgId; do not name getCurrentOrgId or we overwrite global and cause recursion)
function resolveCurrentOrgId() {
    if (typeof window.getCurrentOrgId === 'function') {
        return window.getCurrentOrgId() || null;
    }
    if (window.authModule && window.authModule.isAuthenticated()) {
        const user = window.authModule.getCurrentUser();
        return user.organizationId || user.default_organization_id || null;
    }
    return null;
}

function resolveCurrentUserDisplayName() {
    const u = window.authModule && window.authModule.getCurrentUser && window.authModule.getCurrentUser();
    if (!u) return null;
    const name = u.fullName != null ? String(u.fullName).trim() : '';
    if (name) return name;
    if (u.username) return String(u.username);
    if (u.email) return String(u.email);
    return null;
}

function formatPhotoNoteEditedAt(iso) {
    if (iso == null || iso === '') return '';
    return window.formatRecordedDateTime(iso, '', '');
}

function photoOrgIdMatches(photoOrgId, currentOrgId) {
    if (currentOrgId == null || currentOrgId === '') return false;
    if (photoOrgId == null || photoOrgId === '') return false;
    return Number(photoOrgId) === Number(currentOrgId);
}

// Load saved photos from localStorage (filtered by organization)
function loadSavedPhotos() {
    const currentOrgId = resolveCurrentOrgId();

    try {
        const stored = localStorage.getItem('savedPhotos');
        if (stored) {
            const allPhotos = JSON.parse(stored);
            // Filter by current organization
            savedPhotos = allPhotos.filter((photo) => photoOrgIdMatches(photo.organizationId, currentOrgId));
            // Clear marker references (they'll be recreated when rendering)
            savedPhotos.forEach((photo) => {
                photo.marker = null;
            });
        }
    } catch (error) {
        console.error('Error loading saved photos:', error);
        savedPhotos = [];
    }
}

function tryParse(jsonStr) {
    try {
        return typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
    } catch (_) {
        return null;
    }
}

function escapeHtmlAttr(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Resolve a public-catalog photo stub for fullscreen viewer from popup attrs / PUBLIC_MAP_PHOTOS.
 * @returns {object|null}
 */
function resolvePublicMapPhotoStub(photoId, fileIdAttr) {
    const pid = photoId != null ? String(photoId) : '';
    let fileId = fileIdAttr != null && String(fileIdAttr).trim() !== '' ? Number(fileIdAttr) : NaN;
    if (!Number.isFinite(fileId) && pid.indexOf('public-photo-') === 0) {
        fileId = Number(pid.slice('public-photo-'.length));
    }
    if (!Number.isFinite(fileId) && pid.indexOf('public-photo-') !== 0) {
        return null;
    }
    if (!Number.isFinite(fileId)) return null;

    const rows = window.PUBLIC_MAP_PHOTOS || [];
    const file = rows.find((r) => r && Number(r.id) === fileId);
    const baseUrl =
        window.authModule && window.authModule.getApiBaseForMedia
            ? window.authModule.getApiBaseForMedia()
            : window.API_BASE_URL || window.location.origin;
    if (file) {
        return {
            id: `public-photo-${file.id}`,
            fileId: file.id,
            imageUrl: `${baseUrl}/api/data/media/${file.id}/file`,
            thumbnailUrl:
                file.thumbnailUrl ||
                (file.thumbnailPath ? `/api/data/media/${file.id}/thumbnail` : undefined),
            fileName: file.fileName || 'Photo',
            shared: true,
            sharedSourceLabel: file.sharedSourceLabel,
            readOnly: true,
            associatedNoGps: !!file.associatedNoGps,
        };
    }
    // Fallback when rows were cleared but popup still has fileId
    if (pid.indexOf('public-photo-') === 0 || fileIdAttr) {
        return {
            id: `public-photo-${fileId}`,
            fileId,
            imageUrl: `${baseUrl}/api/data/media/${fileId}/file`,
            thumbnailUrl: `/api/data/media/${fileId}/thumbnail`,
            fileName: 'Photo',
            shared: true,
            readOnly: true,
        };
    }
    return null;
}

function bindPhotoPopupNoteButton(popupEl) {
    if (!popupEl) return;
    popupEl.querySelectorAll('input[data-action="toggle-photo-public"]').forEach(function (cb) {
        if (cb.dataset.bound) return;
        cb.dataset.bound = '1';
        cb.addEventListener('change', async function (ev) {
            ev.stopPropagation();
            const fileId = cb.getAttribute('data-file-id');
            if (!fileId || !window.photosModule || !window.photosModule.setPhotoPublicFlag) return;
            const isPublic = cb.checked;
            try {
                await window.photosModule.setPhotoPublicFlag(Number(fileId), isPublic);
            } catch (err) {
                cb.checked = !isPublic;
                console.error('Failed to update photo public flag:', err);
                if (typeof appAlert === 'function') {
                    await appAlert(err.message || 'Could not update public sharing.');
                }
            }
        });
    });
    popupEl.querySelectorAll('.photo-popup-image, .photo-popup-image-container').forEach(function (img) {
        if (img.dataset.popupImageClickBound === '1') return;
        img.dataset.popupImageClickBound = '1';
        img.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            const pid = img.getAttribute('data-photo-id');
            if (!pid) return;
            const fileIdAttr = img.getAttribute('data-file-id');
            const publicStub = resolvePublicMapPhotoStub(pid, fileIdAttr);
            if (publicStub) {
                if (typeof openPhotoViewer === 'function') {
                    openPhotoViewer(publicStub, publicStub.fileName);
                }
                return;
            }
            if (typeof window.viewPhoto === 'function') {
                window.viewPhoto(pid);
            } else if (window.tableActionsModule && typeof window.tableActionsModule.viewPhoto === 'function') {
                window.tableActionsModule.viewPhoto(pid);
            }
        });
    });
    popupEl.querySelectorAll('.photo-popup-edit-note-btn').forEach(function (btn) {
        if (btn.dataset.bound) return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            const pid = btn.getAttribute('data-photo-id');
            if (pid && window.photosModule && window.photosModule.promptEditPhotoDetails) {
                window.photosModule.promptEditPhotoDetails(pid);
            } else if (pid && window.photosModule && window.photosModule.promptEditPhotoNote) {
                window.photosModule.promptEditPhotoNote(pid);
            }
        });
    });
    popupEl.querySelectorAll('.photo-popup-delete-btn').forEach(function (btn) {
        if (btn.dataset.bound) return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', async function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            const pid = btn.getAttribute('data-photo-id');
            if (!pid) return;
            if (typeof window.closePhotoMapInfoModal === 'function') {
                window.closePhotoMapInfoModal();
            }
            if (typeof window.closePhotoViewer === 'function') {
                window.closePhotoViewer();
            }
            if (window.map && typeof window.map.closePopup === 'function') {
                window.map.closePopup();
            }
            if (typeof window.deletePhoto === 'function') {
                await window.deletePhoto(pid);
            }
        });
    });
    const viewBtn = popupEl.querySelector('.photo-popup-view-info-btn');
    if (viewBtn && !viewBtn.dataset.bound) {
        viewBtn.dataset.bound = '1';
        viewBtn.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            const pid = viewBtn.getAttribute('data-photo-id');
            if (pid) openPhotoMapInfoModal(pid);
        });
    }
}

function buildPhotoMapPopupInfoInnerHtml(photo) {
    const lat = photo.latlng ? Number(photo.latlng.lat) : NaN;
    const lng = photo.latlng ? Number(photo.latlng.lng) : NaN;
    const validLatlng = (Number.isFinite(lat) && Number.isFinite(lng)) ? L.latLng(lat, lng) : null;
    let fileDisplayLabel = '—';
    if (photo.fileName != null && String(photo.fileName).trim() !== '') {
        const fn = String(photo.fileName);
        fileDisplayLabel =
            typeof window.truncateImageNameForDisplay === 'function'
                ? window.truncateImageNameForDisplay(fn) || '—'
                : fn.length > 10
                  ? fn.slice(0, 10) + '...'
                  : fn;
    }
    const safeName = escapeHtmlAttr(fileDisplayLabel);
    const safePhotoId = escapeHtmlAttr(photo.id);
    let html = `<div class="photo-popup-info-row"><strong>File:</strong> ${safeName}</div>`;
    if (photo.uploadedBy) {
        html += `<div class="photo-popup-info-row"><strong>Uploaded by:</strong> ${escapeHtmlAttr(photo.uploadedBy)}</div>`;
    }
    if (photo.note) {
        html += `<div class="photo-popup-info-row photo-popup-note"><strong>Note:</strong> ${escapeHtmlAttr(photo.note)}</div>`;
    }
    const tagMod = window.photoTagsModule;
    const photoTags = tagMod && typeof tagMod.getPhotoTags === 'function' ? tagMod.getPhotoTags(photo) : [];
    if (photoTags.length) {
        const tagsHtml =
            tagMod && typeof tagMod.renderPhotoTagsHtml === 'function'
                ? tagMod.renderPhotoTagsHtml(photoTags)
                : photoTags.map(function (t) { return escapeHtmlAttr(t); }).join(', ');
        html += `<div class="photo-popup-info-row photo-popup-tags-row"><strong>Tags:</strong> ${tagsHtml}</div>`;
    }
    if (photo.note && String(photo.note).trim() && photo.noteLastEditedBy) {
        const when = formatPhotoNoteEditedAt(photo.noteLastEditedAt);
        const whenPart = when ? ` <span class="photo-popup-muted">(${escapeHtmlAttr(when)})</span>` : '';
        html += `<div class="photo-popup-info-row"><strong>Last note by:</strong> ${escapeHtmlAttr(photo.noteLastEditedBy)}${whenPart}</div>`;
    }
    if (!photo.readOnly) {
        const canDelete =
            !window.orgDataPermissionsModule || window.orgDataPermissionsModule.canDeleteOrgData();
        const canEditPhoto =
            !window.orgDataPermissionsModule ||
            window.orgDataPermissionsModule.canEditDataItem('photo', photo);
        html += `<div class="photo-popup-info-row photo-popup-action-row" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;">`;
        if (canEditPhoto) {
            html += `<button type="button" class="photo-popup-edit-note-btn" data-photo-id="${safePhotoId}" style="font-size:0.75rem;padding:4px 8px;cursor:pointer;">Edit note &amp; tags</button>`;
        }
        if (canDelete) {
            html += `<button type="button" class="photo-popup-delete-btn" data-photo-id="${safePhotoId}" style="font-size:0.75rem;padding:4px 8px;cursor:pointer;color:var(--app-danger,#c62828);">Delete photo</button>`;
        }
        html += `</div>`;
    }

    const exifData = photo.exifData;
    if (exifData) {
        if (exifData.dateTime) {
            html += `<div class="photo-popup-info-row"><strong>Date:</strong> ${escapeHtmlAttr(exifData.dateTime)}</div>`;
        }
        if (exifData.make || exifData.model) {
            const camera = [exifData.make, exifData.model].filter(Boolean).join(' ');
            html += `<div class="photo-popup-info-row"><strong>Camera:</strong> ${escapeHtmlAttr(camera)}</div>`;
        }
        const gpsSource = exifData.gpsSource || (exifData.hasGPS ? 'EXIF' : 'None');
        const accuracyVal = Number(exifData.gpsAccuracyMeters);
        const accuracyFormatted =
            Number.isFinite(accuracyVal) && accuracyVal > 0
                ? window.measureModule && typeof window.measureModule.formatGpsAccuracyMeters === 'function'
                    ? window.measureModule.formatGpsAccuracyMeters(accuracyVal)
                    : '\u00B1' + Math.round(accuracyVal) + ' m'
                : '';
        const accuracyPart = accuracyFormatted
            ? ` <span class="photo-popup-muted">(${accuracyFormatted})</span>`
            : '';
        if (validLatlng && (gpsSource === 'EXIF' || gpsSource === 'Manual')) {
            const sourceLabel = gpsSource === 'EXIF' ? 'GPS (EXIF)' : 'GPS (Manual)';
            html += `<div class="photo-popup-info-row photo-popup-gps"><strong>📍 ${sourceLabel}:</strong> ${formatLatLng(validLatlng.lat, validLatlng.lng)}${accuracyPart}</div>`;
            if (gpsSource === 'Manual' && photo.gpsLastEditedBy) {
                const when = formatPhotoNoteEditedAt(photo.gpsLastEditedAt);
                const whenPart = when ? ` <span class="photo-popup-muted">(${escapeHtmlAttr(when)})</span>` : '';
                html += `<div class="photo-popup-info-row"><strong>Last GPS by:</strong> ${escapeHtmlAttr(photo.gpsLastEditedBy)}${whenPart}</div>`;
            }
        } else if (validLatlng && exifData.hasGPS) {
            html += `<div class="photo-popup-info-row photo-popup-gps"><strong>📍 GPS:</strong> ${formatLatLng(validLatlng.lat, validLatlng.lng)}${accuracyPart}</div>`;
        } else if (!validLatlng) {
            html += `<div class="photo-popup-info-row photo-popup-manual"><strong>📍 GPS:</strong> None</div>`;
        }
        const headingVal =
            window.photoCanvasUtils && typeof window.photoCanvasUtils.photoHasHeading === 'function'
                ? window.photoCanvasUtils.photoHasHeading(photo)
                    ? window.photoCanvasUtils.getPhotoHeadingDegrees(photo)
                    : null
                : window.photoCanvasUtils && typeof window.photoCanvasUtils.getPhotoHeadingDegrees === 'function'
                  ? window.photoCanvasUtils.getPhotoHeadingDegrees(photo)
                  : Number(exifData.gpsHeadingDegrees);
        const az =
            headingVal != null &&
            window.photoCanvasUtils &&
            typeof window.photoCanvasUtils.formatPhotoHeadingAzimuth === 'function'
                ? window.photoCanvasUtils.formatPhotoHeadingAzimuth(headingVal)
                : '';
        if (az) {
            html += `<div class="photo-popup-info-row"><strong>Facing:</strong> ${escapeHtmlAttr(az)}</div>`;
        }
    }
    return html;
}

function getMapViewportPhotosList() {
    return window.photoMapLoaderModule && typeof window.photoMapLoaderModule.getMapViewportPhotos === 'function'
        ? window.photoMapLoaderModule.getMapViewportPhotos() || []
        : [];
}

function applyPhotoDetailsFieldsToPhoto(target, fields) {
    if (!target || !fields) return;
    if (Object.prototype.hasOwnProperty.call(fields, 'note')) {
        target.note = fields.note == null ? '' : String(fields.note);
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'tags')) {
        target.tags = Array.isArray(fields.tags) ? fields.tags : [];
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'noteLastEditedBy')) {
        target.noteLastEditedBy = fields.noteLastEditedBy != null ? String(fields.noteLastEditedBy) : '';
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'noteLastEditedAt')) {
        target.noteLastEditedAt = fields.noteLastEditedAt != null ? String(fields.noteLastEditedAt) : '';
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'hasWhitePaintMark')) {
        target.hasWhitePaintMark = !!fields.hasWhitePaintMark;
        if (!target.exifData || typeof target.exifData !== 'object') target.exifData = {};
        target.exifData.hasWhitePaintMark = !!fields.hasWhitePaintMark;
    }
}

/**
 * Map viewport payloads omit note/tags. Keep Manage Data + all map stubs in sync after edits,
 * and upsert a photo-server-* row when the user edited a map-only stub.
 */
function syncPhotoDetailsAcrossLocalCopies(fileId, fields, seedPhoto) {
    const fid = Number(fileId);
    if (!Number.isFinite(fid) || !fields) return null;
    if (!Array.isArray(savedPhotos)) savedPhotos = [];

    let canonical = null;
    savedPhotos.forEach(function (p) {
        if (!p || Number(p.fileId) !== fid) return;
        applyPhotoDetailsFieldsToPhoto(p, fields);
        if (!canonical || String(p.id).indexOf('photo-server-') === 0) canonical = p;
    });
    getMapViewportPhotosList().forEach(function (p) {
        if (p && Number(p.fileId) === fid) applyPhotoDetailsFieldsToPhoto(p, fields);
    });

    if (!canonical) {
        const seed = seedPhoto && Number(seedPhoto.fileId) === fid ? seedPhoto : null;
        canonical = {
            id: 'photo-server-' + fid,
            fileId: fid,
            fileName: (seed && seed.fileName) || 'Photo',
            originalFileName: (seed && (seed.originalFileName || seed.fileName)) || 'Photo',
            imageUrl: seed && seed.imageUrl ? seed.imageUrl : null,
            thumbnailUrl: seed && seed.thumbnailUrl ? seed.thumbnailUrl : null,
            latlng: seed && seed.latlng ? seed.latlng : null,
            exifData: seed && seed.exifData && typeof seed.exifData === 'object' ? seed.exifData : {},
            createdAt: (seed && seed.createdAt) || new Date().toISOString(),
            organizationId: resolveCurrentOrgId(),
            batchId: seed && seed.batchId ? seed.batchId : null,
            marker: null,
            uploadedBy: seed && seed.uploadedBy ? seed.uploadedBy : '',
        };
        applyPhotoDetailsFieldsToPhoto(canonical, fields);
        savedPhotos.push(canonical);
    }
    return canonical;
}

/** Copy note/tags from Manage Data onto map viewport stubs for popup/info display. */
function enrichPhotoDetailsFromLocalCopies(photo) {
    if (!photo || photo.fileId == null) return photo;
    const fid = Number(photo.fileId);
    if (!Number.isFinite(fid)) return photo;
    const local = (savedPhotos || []).find(function (p) {
        return p && Number(p.fileId) === fid && String(p.id).indexOf('photo-server-') === 0;
    }) || (savedPhotos || []).find(function (p) {
        return p && Number(p.fileId) === fid && String(p.id) !== String(photo.id);
    });
    if (!local || local === photo) return photo;
    const isMapStub =
        photo.mapViewport === true || String(photo.id || '').indexOf('map-photo-') === 0;
    if (!isMapStub && String(photo.id || '').indexOf('photo-server-') === 0) return photo;
    // Prefer map/API values when present; only fill gaps from Manage Data (avoid wiping
    // fresh photo-map note/tags with an empty/stale local row).
    const photoNote = photo.note != null ? String(photo.note).trim() : '';
    const localNote = local.note != null ? String(local.note).trim() : '';
    if (!photoNote && local.note != null) photo.note = local.note;
    else if (localNote && local.noteLastEditedAt && photo.noteLastEditedAt &&
        String(local.noteLastEditedAt) > String(photo.noteLastEditedAt)) {
        photo.note = local.note;
        if (local.noteLastEditedBy) photo.noteLastEditedBy = local.noteLastEditedBy;
        photo.noteLastEditedAt = local.noteLastEditedAt;
    }
    if ((!Array.isArray(photo.tags) || !photo.tags.length) && Array.isArray(local.tags) && local.tags.length) {
        photo.tags = local.tags;
    }
    if (!photo.noteLastEditedBy && local.noteLastEditedBy) photo.noteLastEditedBy = local.noteLastEditedBy;
    if (!photo.noteLastEditedAt && local.noteLastEditedAt) photo.noteLastEditedAt = local.noteLastEditedAt;
    if (photo.hasWhitePaintMark == null && local.hasWhitePaintMark != null) {
        photo.hasWhitePaintMark = local.hasWhitePaintMark;
    }
    if (local.uploadedBy && !photo.uploadedBy) photo.uploadedBy = local.uploadedBy;
    if (local.exifData && typeof local.exifData === 'object') {
        photo.exifData = Object.assign({}, local.exifData, photo.exifData || {});
    }
    return photo;
}

/**
 * Resolve a photo for info/edit UI. Map markers use `map-photo-{fileId}` while
 * Manage Data / localStorage use `photo-server-{fileId}` — match by id or fileId
 * across savedPhotos and viewport photos.
 */
function findPhotoForUi(photoId) {
    if (photoId == null || photoId === '') return null;
    const idStr = String(photoId);
    const list = Array.isArray(savedPhotos) ? savedPhotos : [];
    let photo = list.find(function (p) { return p && String(p.id) === idStr; });
    if (photo) return enrichPhotoDetailsFromLocalCopies(photo);

    let fileId = null;
    const prefixed = idStr.match(/^(?:map-photo|photo-server|gallery-photo)-(\d+)$/i);
    if (prefixed) {
        fileId = Number(prefixed[1]);
    } else if (/^\d+$/.test(idStr)) {
        fileId = Number(idStr);
    }
    if (fileId != null && Number.isFinite(fileId)) {
        photo =
            list.find(function (p) {
                return p && Number(p.fileId) === fileId && String(p.id).indexOf('photo-server-') === 0;
            }) || list.find(function (p) { return p && Number(p.fileId) === fileId; });
        if (photo) return enrichPhotoDetailsFromLocalCopies(photo);
    }

    const viewport = getMapViewportPhotosList();
    photo = viewport.find(function (p) { return p && String(p.id) === idStr; });
    if (photo) return enrichPhotoDetailsFromLocalCopies(photo);
    if (fileId != null && Number.isFinite(fileId)) {
        photo = viewport.find(function (p) { return p && Number(p.fileId) === fileId; });
        if (photo) return enrichPhotoDetailsFromLocalCopies(photo);
    }
    return null;
}

function openPhotoMapInfoModal(photoId) {
    const photo = findPhotoForUi(photoId);
    if (!photo) return;
    const modal = document.getElementById('photoMapInfoModal');
    const body = document.getElementById('photoMapInfoModalBody');
    if (!modal || !body) return;
    modal.dataset.photoId = String(photo.id || photoId);
    body.innerHTML = `<div class="photo-popup-info photo-popup-info--modal-panel">${buildPhotoMapPopupInfoInnerHtml(photo)}</div>`;
    bindPhotoPopupNoteButton(body);
    modal.classList.add('show');
}

function closePhotoMapInfoModal() {
    const modal = document.getElementById('photoMapInfoModal');
    if (modal) {
        modal.dataset.photoId = '';
        modal.classList.remove('show');
    }
}

document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    const infoModal = document.getElementById('photoMapInfoModal');
    if (infoModal && infoModal.classList.contains('show')) {
        closePhotoMapInfoModal();
    }
});

function buildPhotoMapPopupHtml(photo) {
    enrichPhotoDetailsFromLocalCopies(photo);
    const thumbUrl = getPhotoThumbnailDisplayUrl(photo);
    const imageUrl = thumbUrl || getPhotoImageUrl(photo);
    const altRaw = photo.fileName != null && String(photo.fileName).trim() !== '' ? String(photo.fileName) : 'Photo';
    const altTrunc =
        typeof window.truncateImageNameForDisplay === 'function'
            ? window.truncateImageNameForDisplay(altRaw) || 'Photo'
            : altRaw.length > 10
              ? altRaw.slice(0, 10) + '...'
              : altRaw;
    const safeName = escapeHtmlAttr(altTrunc);
    const safePhotoId = escapeHtmlAttr(photo.id);
    // Do not put an <img> in the map popup until a real URL is mounted. WebKit paints a
    // beveled black tile for missing/failed src even when the element is opacity:0.
    const fileIdAttr = photo.fileId
        ? ` data-file-id="${escapeHtmlAttr(String(photo.fileId))}"${photo.thumbnailUrl ? ' data-use-thumbnail="1"' : ''}`
        : '';
    const srcAttr = !photo.fileId && imageUrl ? ` src="${escapeHtmlAttr(imageUrl)}"` : '';
    const imgHtml =
        !photo.fileId && imageUrl
            ? `<img data-photo-id="${safePhotoId}"${srcAttr} alt="${safeName}" class="photo-popup-image" style="cursor: pointer;" />`
            : '';
    const infoInner = buildPhotoMapPopupInfoInnerHtml(photo);
    return `
        <div class="photo-popup">
            <div class="photo-popup-image-container" data-photo-id="${safePhotoId}"${fileIdAttr} style="cursor: pointer;">
                <span class="photo-popup-image-placeholder" aria-hidden="true">${getPhotoMapMarkerIconInnerHtml()}</span>
                ${imgHtml}
            </div>
            <div class="photo-popup-actions photo-popup-actions--mobile">
                <button type="button" class="photo-popup-view-info-btn" data-photo-id="${safePhotoId}">View info</button>
                ${photo.readOnly ? '' : `<button type="button" class="photo-popup-edit-note-btn" data-photo-id="${safePhotoId}" style="font-size:0.75rem;padding:4px 8px;cursor:pointer;">Edit note &amp; tags</button>`}
            </div>
            <div class="photo-popup-info photo-popup-info--desktop">
                ${infoInner}
            </div>
        </div>`;
}

function centerMapOnPhotoPopup(marker) {
    const map = marker._map;
    if (!map || typeof map.panTo !== 'function') return;
    // leaflet.markercluster reclusters on moveend. Panning the map (even slightly) can drop
    // spiderfied legs or otherwise detach the marker and close the popup after the pan finishes.
    if (
        photosMarkerClusterGroup &&
        typeof L !== 'undefined' &&
        L.MarkerClusterGroup &&
        photosMarkerClusterGroup instanceof L.MarkerClusterGroup
    ) {
        return;
    }
    const latlng = marker.getLatLng && marker.getLatLng();
    if (!latlng) return;

    requestAnimationFrame(function () {
        requestAnimationFrame(function () {
            map.panTo(latlng, { animate: true });
        });
    });
}

/**
 * Wheel events on the marker icon should not zoom the map. Do not use
 * L.DomEvent.disableClickPropagation on the icon: it sets _leaflet_disable_click, and Leaflet 1.9+
 * then ignores the entire click in _handleDOMEvent — so bindPopup never receives the click (very
 * visible on spiderfied photo cluster markers). Popup pane still uses disableClickPropagation below.
 */
function wirePhotoMapMarkerLeafletMobile(marker) {
    if (!marker || marker._photoMarkerMobileTouchWired || typeof marker.on !== 'function') return;
    marker._photoMarkerMobileTouchWired = true;
    marker.on('add', function () {
        const iconEl = typeof this.getElement === 'function' ? this.getElement() : this._icon;
        if (!iconEl || !L.DomEvent) return;
        if (typeof L.DomEvent.disableScrollPropagation === 'function') {
            L.DomEvent.disableScrollPropagation(iconEl);
        }
    });
    marker.on('popupopen', function () {
        const popup = this.getPopup && this.getPopup();
        const el = popup && popup.getElement && popup.getElement();
        if (el && L.DomEvent) {
            L.DomEvent.disableClickPropagation(el);
        }
    });
}

function isPhotoManualGps(photo) {
    if (!photo || !photo.latlng) return false;
    const src = photo.exifData && photo.exifData.gpsSource;
    return src === 'Manual';
}

function formatPhotoGpsLastEditedLine(photo) {
    if (!photo || !photo.gpsLastEditedBy) return '';
    let line = String(photo.gpsLastEditedBy);
    if (photo.gpsLastEditedAt) {
        const when = formatPhotoNoteEditedAt(photo.gpsLastEditedAt);
        if (when) line += ' (' + when + ')';
    }
    return line;
}

function setPhotoGpsLocally(photo, lat, lng) {
    if (!photo) return;
    photo.latlng = { lat: Number(lat), lng: Number(lng) };
    if (!photo.exifData || typeof photo.exifData !== 'object') {
        photo.exifData = {};
    }
    photo.exifData.gpsSource = 'Manual';
    photo.exifData.hasGPS = true;
    photo.exifData.gpsLat = Number(lat);
    photo.exifData.gpsLng = Number(lng);
}

function clearPhotoGpsLocally(photo) {
    if (!photo) return;
    delete photo.latlng;
    delete photo.lat;
    delete photo.lng;
    if (!photo.exifData || typeof photo.exifData !== 'object') {
        photo.exifData = {};
    }
    photo.exifData.gpsSource = 'None';
    photo.exifData.hasGPS = false;
    delete photo.exifData.gpsLat;
    delete photo.exifData.gpsLng;
}

function visitPhotoMapLayerGroup(group, callback) {
    if (!group || typeof group.eachLayer !== 'function') return;
    group.eachLayer(function (layer) {
        if (layer && typeof layer.getAllChildMarkers === 'function') {
            layer.getAllChildMarkers().forEach(callback);
        } else {
            callback(layer);
        }
    });
}

function forEachPhotoMapLayer(callback) {
    if (photosMarkerClusterGroup) visitPhotoMapLayerGroup(photosMarkerClusterGroup, callback);
    if (photosServerClusterLayer) visitPhotoMapLayerGroup(photosServerClusterLayer, callback);
    else if (photosLayerGroup) visitPhotoMapLayerGroup(photosLayerGroup, callback);
}

function getPhotoClusterDrawerZoom(map) {
    const mapMax = map && map.getMaxZoom ? map.getMaxZoom() : PHOTO_CLUSTER_DRAWER_ZOOM;
    return Math.min(PHOTO_CLUSTER_DRAWER_ZOOM, mapMax);
}

function getPhotosPointMarkerLayer() {
    return photosMarkerClusterGroup || photosLayerGroup;
}

function getPhotosServerClusterLayer() {
    return photosServerClusterLayer || photosLayerGroup;
}

function clearPhotoMapChildLayers() {
    if (photosMarkerClusterGroup && typeof photosMarkerClusterGroup.clearLayers === 'function') {
        photosMarkerClusterGroup.clearLayers();
    }
    if (photosServerClusterLayer && typeof photosServerClusterLayer.clearLayers === 'function') {
        photosServerClusterLayer.clearLayers();
    }
    if (
        photosLayerGroup &&
        !photosMarkerClusterGroup &&
        typeof photosLayerGroup.clearLayers === 'function'
    ) {
        photosLayerGroup.clearLayers();
    }
}

function photoFileIdsMatch(a, b) {
    if (a == null || b == null) return false;
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
    return String(a) === String(b);
}

function findPhotoMapMarker(photo) {
    if (!photo) return null;
    if (photo.marker) return photo.marker;
    let found = null;
    forEachPhotoMapLayer(function (marker) {
        if (found || !marker || !marker.options) return;
        if (marker.options.photoId === photo.id) {
            found = marker;
            return;
        }
        if (photo.fileId != null && photoFileIdsMatch(marker.options.fileId, photo.fileId)) {
            found = marker;
        }
    });
    return found;
}

function detachPhotoMapMarkerFromMap(marker) {
    if (!marker) return;
    if (photosMarkerClusterGroup && typeof photosMarkerClusterGroup.removeLayer === 'function') {
        photosMarkerClusterGroup.removeLayer(marker);
    } else if (photosLayerGroup && typeof photosLayerGroup.removeLayer === 'function') {
        photosLayerGroup.removeLayer(marker);
    } else if (window.map && window.map.hasLayer(marker)) {
        window.map.removeLayer(marker);
    } else if (typeof marker.remove === 'function') {
        marker.remove();
    }
}

/** Clear marker refs on Manage Data + viewport photo objects that share this fileId/id. */
function clearPhotoMarkerRefsForPhoto(photo) {
    if (!photo) return;
    photo.marker = null;
    const fid = photo.fileId;
    if (Array.isArray(savedPhotos)) {
        savedPhotos.forEach((p) => {
            if (!p) return;
            if (p.id === photo.id || (fid != null && photoFileIdsMatch(p.fileId, fid))) {
                p.marker = null;
            }
        });
    }
    const loader = window.photoMapLoaderModule;
    if (loader && typeof loader.getMapViewportPhotos === 'function') {
        (loader.getMapViewportPhotos() || []).forEach((p) => {
            if (!p) return;
            if (p.id === photo.id || (fid != null && photoFileIdsMatch(p.fileId, fid))) {
                p.marker = null;
            }
        });
    }
    if (Array.isArray(window.photoMarkers)) {
        window.photoMarkers = window.photoMarkers.filter((p) => {
            if (!p) return false;
            if (p.id === photo.id) return false;
            if (fid != null && photoFileIdsMatch(p.fileId, fid)) return false;
            return true;
        });
    }
}

function removePhotoMarker(photo) {
    if (!photo) return;
    const marker = findPhotoMapMarker(photo);
    if (marker) detachPhotoMapMarkerFromMap(marker);
    // Also detach any duplicate markers for the same fileId (viewport vs Manage Data id mismatch).
    if (photo.fileId != null) {
        const extras = [];
        forEachPhotoMapLayer(function (m) {
            if (m && m.options && photoFileIdsMatch(m.options.fileId, photo.fileId)) extras.push(m);
        });
        extras.forEach(detachPhotoMapMarkerFromMap);
    }
    clearPhotoMarkerRefsForPhoto(photo);
}

/**
 * Keep viewport photo stubs + map cache in sync after manual GPS set/clear so the pin
 * moves immediately (not only after a later resync).
 * @param {object} photo
 * @param {{ lat: number, lng: number }|null} latlng null clears GPS from the map
 */
function syncPhotoMapAfterGpsChange(photo, latlng) {
    if (!photo) return;
    const loader = window.photoMapLoaderModule;
    if (loader && typeof loader.patchMapViewportPhotoGps === 'function' && photo.fileId != null) {
        loader.patchMapViewportPhotoGps(photo.fileId, latlng);
    }
    if (latlng && Number.isFinite(Number(latlng.lat)) && Number.isFinite(Number(latlng.lng))) {
        placeOrMovePhotoMarker(photo, latlng);
    } else {
        removePhotoMarker(photo);
    }
    if (loader && typeof loader.invalidatePhotoMapCache === 'function') {
        loader.invalidatePhotoMapCache();
    }
    if (loader && typeof loader.scheduleFetchPhotoMapForViewport === 'function') {
        loader.scheduleFetchPhotoMapForViewport(true);
    }
}

function applyPhotoGpsMetadataFromResponse(photo, metadata) {
    if (!photo || !metadata || typeof metadata !== 'object') return;
    const m = metadata;
    if (typeof m.gpsLastEditedBy === 'string') photo.gpsLastEditedBy = m.gpsLastEditedBy;
    if (typeof m.gpsLastEditedAt === 'string') photo.gpsLastEditedAt = m.gpsLastEditedAt;
    if (!photo.exifData || typeof photo.exifData !== 'object') photo.exifData = {};
    const exif = m.exif && typeof m.exif === 'object' ? m.exif : {};
    const gpsSource =
        typeof exif.gpsSource === 'string'
            ? exif.gpsSource
            : typeof m.gpsSource === 'string'
              ? m.gpsSource
              : null;
    if (typeof gpsSource === 'string') photo.exifData.gpsSource = gpsSource;
    const lat = m.lat != null ? Number(m.lat) : NaN;
    const lng = m.lng != null ? Number(m.lng) : NaN;
    const hasGps =
        m.hasGPS === true ||
        (Number.isFinite(lat) && Number.isFinite(lng) && gpsSource !== 'None');
    if (hasGps && Number.isFinite(lat) && Number.isFinite(lng)) {
        setPhotoGpsLocally(photo, lat, lng);
    } else if (m.hasGPS === false || gpsSource === 'None') {
        clearPhotoGpsLocally(photo);
        removePhotoMarker(photo);
    }
}

async function patchPhotoGpsOnServer(fileId, lat, lng, password) {
    if (!fileId || !window.authModule || !window.authModule.isAuthenticated()) {
        throw new Error('Not authenticated or missing file id');
    }
    const orgId = resolveCurrentOrgId();
    const url = `${window.authModule.API_BASE}/data/media/${fileId}${orgId != null ? `?organizationId=${encodeURIComponent(String(orgId))}` : ''}`;
    const body = {
        lat: Number(lat),
        lng: Number(lng),
        hasGPS: true,
        gpsSource: 'Manual',
    };
    if (password) body.password = String(password);
    const response = await window.authModule.apiRequest(url, {
        method: 'PATCH',
        body: JSON.stringify(body),
    });
    return response;
}

async function clearPhotoGpsOnServer(fileId, password) {
    if (!fileId || !window.authModule || !window.authModule.isAuthenticated()) {
        throw new Error('Not authenticated or missing file id');
    }
    const orgId = resolveCurrentOrgId();
    const url = `${window.authModule.API_BASE}/data/media/${fileId}${orgId != null ? `?organizationId=${encodeURIComponent(String(orgId))}` : ''}`;
    const body = { hasGPS: false };
    if (password) body.password = String(password);
    const response = await window.authModule.apiRequest(url, {
        method: 'PATCH',
        body: JSON.stringify(body),
    });
    return response;
}

/**
 * DELETE a media file on the server. Resolves on success; treats 404 (already gone) as success.
 * Throws on any other failure so callers can keep the photo visible and retry.
 */
