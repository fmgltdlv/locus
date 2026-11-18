/**
 * Explicit ticket association for photos without GPS (general upload + Manage Data).
 * DIRT capture uses implicit ticket via photoUploadAssociationContext.
 */

const PHOTO_RECENT_DAYS_ALL = 0;
const TICKET_PHOTO_RECENT_DAYS_OPTIONS = [90, 180, 365];
const TICKET_PHOTO_RECENT_DAYS_DEFAULT = 90;

function normalizeTicketPhotoRecentDays(value) {
    const n = Number(value);
    if (n === PHOTO_RECENT_DAYS_ALL) return PHOTO_RECENT_DAYS_ALL;
    if (TICKET_PHOTO_RECENT_DAYS_OPTIONS.indexOf(n) !== -1) return n;
    return TICKET_PHOTO_RECENT_DAYS_DEFAULT;
}

function formatPhotoRecentDaysLabel(days) {
    const n = normalizeTicketPhotoRecentDays(days);
    if (n === PHOTO_RECENT_DAYS_ALL) return 'All photos';
    return `Last ${n} days`;
}

function getTicketPhotoRecentDaysPreference() {
    const p = typeof window.getUserProfile === 'function' ? window.getUserProfile() : {};
    return normalizeTicketPhotoRecentDays(p.ticketPhotoRecentDays);
}

function photoHasValidGpsPair(lat, lng) {
    if (lat == null || lng == null || lat === '' || lng === '') return false;
    const la = Number(lat);
    const ln = Number(lng);
    return Number.isFinite(la) && Number.isFinite(ln);
}

function photoHasCoordinates(photo) {
    if (!photo || typeof photo !== 'object') return false;
    if (photo.latlng && photoHasValidGpsPair(photo.latlng.lat, photo.latlng.lng)) {
        return true;
    }
    if (photoHasValidGpsPair(photo.lat, photo.lng)) {
        return true;
    }
    const exif = photo.exifData;
    if (!exif || typeof exif !== 'object') return false;
    if (exif.hasGPS === false || exif.gpsSource === 'None') return false;
    return photoHasValidGpsPair(exif.gpsLat, exif.gpsLng);
}

function getPhotoAssociatedTicketId(photo) {
    if (!photo) return null;
    if (photo.associatedTicketId != null && photo.associatedTicketId !== '') {
        const n = Number(photo.associatedTicketId);
        return Number.isFinite(n) ? n : null;
    }
    const exif = photo.exifData;
    if (exif && exif.associatedTicketId != null) {
        const n = Number(exif.associatedTicketId);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function photoMayHaveWhitePaintTag(photo) {
    if (!photo) return false;
    if (photoHasCoordinates(photo)) return true;
    return getPhotoAssociatedTicketId(photo) != null;
}

function photoHasWhitePaintMark(photo) {
    if (!photo) return false;
    const tagMod = window.photoTagsModule;
    if (tagMod && typeof tagMod.photoHasTag === 'function') {
        if (tagMod.photoHasTag(photo, tagMod.WHITE_PAINT_CANONICAL || 'White Paint')) return true;
    }
    if (photo.hasWhitePaintMark === true) return true;
    if (photo.exifData && photo.exifData.hasWhitePaintMark === true) return true;
    const fid = photo.fileId;
    if (fid == null || !window.photosModule || !Array.isArray(window.photosModule.savedPhotos)) {
        return false;
    }
    const local = window.photosModule.savedPhotos.find((p) => p && Number(p.fileId) === Number(fid));
    if (!local) return false;
    if (tagMod && typeof tagMod.getPhotoTags === 'function') {
        const tags = tagMod.getPhotoTags(local);
        if (tagMod.photoTagsIncludeWhitePaint(tags)) return true;
    }
    if (local.hasWhitePaintMark === true) return true;
    return !!(local.exifData && local.exifData.hasWhitePaintMark === true);
}

function photoIsAssociatedNoGpsForTicket(photo, ticket) {
    if (!photo || !ticket || photoHasCoordinates(photo)) return false;
    const tid = getPhotoAssociatedTicketId(photo);
    if (tid == null) return false;
    const ticketId = ticket.id;
    if (typeof window.ticketIdEquals === 'function') {
        return window.ticketIdEquals(tid, ticketId);
    }
    return String(tid) === String(ticketId);
}

function photoMatchesRecentWindow(photo, days) {
    const windowDays = normalizeTicketPhotoRecentDays(days != null ? days : getTicketPhotoRecentDaysPreference());
    if (windowDays === PHOTO_RECENT_DAYS_ALL) return true;
    const imp = window.ticketImporterModule;
    const ms =
        imp && typeof imp.getPhotoCreatedAtMs === 'function'
            ? imp.getPhotoCreatedAtMs(photo)
            : photo && photo.createdAt
              ? new Date(photo.createdAt).getTime()
              : NaN;
    if (!Number.isFinite(ms)) return true;
    const cut = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    return ms >= cut;
}

function listAssociatedNoGpsPhotosForTicket(ticket) {
    if (!ticket) return [];
    const photos = (window.photosModule && window.photosModule.savedPhotos) || [];
    return photos.filter((p) => photoIsAssociatedNoGpsForTicket(p, ticket));
}

async function patchPhotoServerFields(fileId, fields) {
    if (fileId == null || !window.authModule || !window.authModule.isAuthenticated()) {
        throw new Error('Not authenticated');
    }
    const orgId = typeof window.getCurrentOrgId === 'function' ? window.getCurrentOrgId() : null;
    const qs = orgId ? `?organizationId=${encodeURIComponent(String(orgId))}` : '';
    const res = await window.authModule.apiRequest(`${window.authModule.API_BASE}/data/media/${fileId}${qs}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields || {}),
    });
    return res;
}

function applyAssociationFieldsToLocalPhoto(photo, ticketId, source, extra) {
    if (!photo) return;
    const extraFields = extra && typeof extra === 'object' ? extra : {};
    photo.associatedTicketId = ticketId;
    photo.associationSource = source || null;
    photo.associatedAt = new Date().toISOString();
    if (!photo.exifData || typeof photo.exifData !== 'object') photo.exifData = {};
    photo.exifData.associatedTicketId = ticketId;
    photo.exifData.associationSource = source || null;
    if (extraFields.hasWhitePaintMark != null) {
        photo.hasWhitePaintMark = !!extraFields.hasWhitePaintMark;
        photo.exifData.hasWhitePaintMark = !!extraFields.hasWhitePaintMark;
    }
    if (extraFields.dirtEventId != null) {
        photo.dirtEventId = extraFields.dirtEventId;
        photo.exifData.dirtEventId = extraFields.dirtEventId;
    }
}

function invalidateTicketPhotoIntersectionForTicket(ticketId) {
    (window.ORG_TICKETS || []).forEach((t) => {
        if (typeof window.ticketIdEquals === 'function' ? !window.ticketIdEquals(t.id, ticketId) : String(t.id) !== String(ticketId)) {
            return;
        }
        if (t.ticketPhotoStats && typeof t.ticketPhotoStats === 'object') {
            t.ticketPhotoStats.stale = true;
        }
    });
}

function refreshTicketUiAfterPhotoAssociation(ticketId) {
    const ticket = resolveTicketForAssociationPick(ticketId);
    if (!ticket) return;
    if (window.ticketImporterModule && typeof window.ticketImporterModule.applyTicketStatusFromImporter === 'function') {
        window.ticketImporterModule.applyTicketStatusFromImporter(ticket);
    }
    if (typeof window.renderTicketList === 'function') {
        window.renderTicketList();
    }
    if (window.ticketHubModule && typeof window.ticketHubModule.redrawIfOpen === 'function') {
        window.ticketHubModule.redrawIfOpen();
    }
    if (typeof window.showTicketPopup === 'function') {
        window.showTicketPopup(ticket);
    }
}

async function associatePhotosWithTicket(fileIds, ticketId, source, extra) {
    const ids = [...new Set((fileIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id)))];
    if (!ids.length || ticketId == null) return null;
    const photos = (window.photosModule && window.photosModule.savedPhotos) || [];
    const assocSource = source || 'upload_prompt';
    const assocTicketId = Number(ticketId);
    for (const fileId of ids) {
        await patchPhotoServerFields(fileId, {
            associatedTicketId: assocTicketId,
            associationSource: assocSource,
            dirtEventId: extra && extra.dirtEventId != null ? extra.dirtEventId : undefined,
        });
        const local = photos.find((p) => Number(p.fileId) === fileId);
        applyAssociationFieldsToLocalPhoto(local, assocTicketId, assocSource, extra);
    }
    if (window.photosModule && typeof window.photosModule.savePhotos === 'function') {
        window.photosModule.savePhotos();
    }
    invalidateTicketPhotoIntersectionForTicket(assocTicketId);
    refreshTicketUiAfterPhotoAssociation(assocTicketId);
    if (
        window.ticketsModule &&
        typeof window.ticketsModule.scheduleTicketPhotoIntersectionRefresh === 'function'
    ) {
        window.ticketsModule.scheduleTicketPhotoIntersectionRefresh('photo-association', {
            recomputeLocalStatus: true,
        });
    } else if (typeof window.recomputeCachedTicketStatusesAfterPhotoChange === 'function') {
        window.recomputeCachedTicketStatusesAfterPhotoChange();
    }
    if (window.refreshDataWindow) window.refreshDataWindow();
    return assocTicketId;
}

let photoAssociationRestoreDataHub = false;

function restoreDataHubAfterPhotoAssociationIfNeeded() {
    if (!photoAssociationRestoreDataHub) return;
    photoAssociationRestoreDataHub = false;
    if (typeof window.openDataWindow === 'function') {
        setTimeout(() => window.openDataWindow(), 100);
    }
}

function cancelPhotoTicketAssociationPick(opts) {
    window.photoTicketAssociationPickMode = false;
    window.photoTicketAssociationOnPick = null;
    window.photoTicketAssociationPendingFileIds = null;
    if (window.ticketsModule && typeof window.ticketsModule.restoreTicketMapPolygonStyles === 'function') {
        window.ticketsModule.restoreTicketMapPolygonStyles();
    }
    const map = window.map;
    if (map && map.getContainer()) {
        map.getContainer().style.cursor = '';
    }
    if (!opts || !opts.skipRestoreDataHub) {
        restoreDataHubAfterPhotoAssociationIfNeeded();
    }
}

function resolveTicketForAssociationPick(ticketId) {
    const tickets = window.ORG_TICKETS || [];
    if (typeof window.ticketIdEquals === 'function') {
        return tickets.find((t) => window.ticketIdEquals(t.id, ticketId)) || null;
    }
    return tickets.find((t) => String(t.id) === String(ticketId)) || null;
}

async function reopenTicketPopupForTicketId(ticketId) {
    const ticket = resolveTicketForAssociationPick(ticketId);
    if (!ticket) return;
    if (typeof window.selectTicket === 'function') {
        window.selectTicket(ticket.id);
    }
    if (typeof window.showTicketPopup === 'function') {
        window.showTicketPopup(ticket);
    }
}

async function startPhotoTicketAssociationPick(fileIds, options) {
    const opts = options || {};
    const ids = [...new Set((fileIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id)))];
    if (!ids.length) return;

    cancelPhotoTicketAssociationPick({ skipRestoreDataHub: true });
    window.photoTicketAssociationPendingFileIds = ids;
    window.photoTicketAssociationPickMode = true;

    const dataWindow = document.getElementById('dataWindow');
    const wasOpen = !!(dataWindow && dataWindow.classList.contains('show'));
    if (wasOpen && typeof window.closeDataWindow === 'function') {
        window.closeDataWindow();
    }
    photoAssociationRestoreDataHub = photoAssociationRestoreDataHub || wasOpen;

    window.photoTicketAssociationOnPick = async function (ticket) {
        if (!ticket || ticket.id == null) return;
        const label = ticket.ticketNumber != null ? String(ticket.ticketNumber) : String(ticket.id);
        const count = ids.length;
        const body =
            count === 1
                ? `Attach this photo to ticket #${label}?`
                : `Attach ${count} photos to ticket #${label}?`;
        const ok = await appConfirm(body, { title: 'Associate photo to ticket', confirmText: 'Attach', cancelText: 'Pick another' });
        if (!ok) return;

        try {
            await associatePhotosWithTicket(ids, ticket.id, opts.source || 'upload_prompt', opts.extra);
        } catch (err) {
            console.error('associatePhotosWithTicket:', err);
            await appAlert(err.message || 'Failed to associate photo with ticket.');
            return;
        }

        const restoreHub = photoAssociationRestoreDataHub;
        cancelPhotoTicketAssociationPick();
        if (opts.reopenTicketPopup !== false && !restoreHub) {
            await reopenTicketPopupForTicketId(ticket.id);
        }
        if (typeof opts.onComplete === 'function') {
            opts.onComplete(ticket);
        }
    };

    const map = window.map;
    if (map && map.getContainer()) {
        map.getContainer().style.cursor = 'crosshair';
    }
    if (window.ticketsModule && typeof window.ticketsModule.highlightTicketPolygonsForQueryMode === 'function') {
        window.ticketsModule.highlightTicketPolygonsForQueryMode();
    }
    const onEscape = function (e) {
        if (e.key !== 'Escape' || !window.photoTicketAssociationPickMode) return;
        document.removeEventListener('keydown', onEscape);
        cancelPhotoTicketAssociationPick();
    };
    document.addEventListener('keydown', onEscape);
    await appAlert('Click a ticket polygon on the map to associate the photo. Press Escape to cancel.', {
        title: 'Select ticket',
    });
}

function findLocalPhotoByFileId(fileId) {
    const photos = (window.photosModule && window.photosModule.savedPhotos) || [];
    const fid = Number(fileId);
    if (!Number.isFinite(fid)) return null;
    return photos.find((p) => Number(p.fileId) === fid) || null;
}

function startPhotoMapTaggingForFileId(fileId) {
    const photo = findLocalPhotoByFileId(fileId);
    if (!photo || !photo.id) {
        void appAlert('Photo not found. You can tag it later from Data Management.');
        return;
    }
    if (window.tableActionsModule && typeof window.tableActionsModule.pickPhotoLocationOnMap === 'function') {
        window.tableActionsModule.pickPhotoLocationOnMap(photo.id, {
            promptMessage: 'Click on the map to tag the location for this photo.',
            successMessage: 'Photo location tagged successfully!',
        });
        return;
    }
    if (typeof window.tagPhotoLocation === 'function') {
        window.tagPhotoLocation(photo.id);
        return;
    }
    void appAlert('Map tagging is not available. Try again from Data Management.');
}

async function promptNoGpsPhotoAssociation(fileIds) {
    const ids = [...new Set((fileIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id)))];
    if (!ids.length) return;

    if (typeof window.closeTicketPopup === 'function') {
        window.closeTicketPopup();
    }

    const count = ids.length;
    if (count === 1) {
        const choice = await appChoice(
            'No GPS was detected for this photo. Tag it on the map or associate it to a ticket?',
            {
                title: 'No GPS detected',
                choices: [
                    { id: 'map', label: 'Tag on map', variant: 'primary' },
                    { id: 'ticket', label: 'Associate to ticket', variant: 'secondary' },
                ],
                cancelText: 'Not now',
            }
        );
        if (choice === 'map') {
            startPhotoMapTaggingForFileId(ids[0]);
            return;
        }
        if (choice === 'ticket') {
            await startPhotoTicketAssociationPick(ids, { source: 'upload_prompt', reopenTicketPopup: true });
        }
        return;
    }

    const body = `No GPS was detected for ${count} photos. Associate them to a ticket?`;
    const want = await appConfirm(body, {
        title: 'No GPS detected',
        confirmText: 'Associate to ticket',
        cancelText: 'Not now',
    });
    if (!want) return;

    await startPhotoTicketAssociationPick(ids, { source: 'upload_prompt', reopenTicketPopup: true });
}

async function associatePhotoFromManageData(photoId) {
    const photos = (window.photosModule && window.photosModule.savedPhotos) || [];
    const photo = photos.find((p) => String(p.id) === String(photoId));
    if (!photo || !photo.fileId) {
        await appAlert('Photo not found.');
        return;
    }
    if (photoHasCoordinates(photo)) {
        await appAlert('This photo already has a GPS location. Ticket association is for photos without coordinates.');
        return;
    }
    await startPhotoTicketAssociationPick([Number(photo.fileId)], {
        source: 'manage_data',
        reopenTicketPopup: true,
    });
}

async function handlePostUploadNoGps(fileId, hasGps) {
    const ctx = window.photoUploadAssociationContext;
    if (ctx && ctx.source === 'dirt' && ctx.ticketId != null && !hasGps) {
        try {
            await associatePhotosWithTicket([Number(fileId)], ctx.ticketId, 'dirt', {
                dirtEventId: ctx.dirtEventId || null,
            });
            if (Array.isArray(ctx.pendingFileIds)) ctx.pendingFileIds.push(Number(fileId));
            if (typeof ctx.onPhotoAssociated === 'function') {
                ctx.onPhotoAssociated(Number(fileId), ctx.ticketId);
            }
        } catch (err) {
            console.error('DIRT implicit association failed:', err);
        }
        return;
    }
    if (!hasGps && fileId != null) {
        if (!window._pendingNoGpsAssociationFileIds) window._pendingNoGpsAssociationFileIds = [];
        window._pendingNoGpsAssociationFileIds.push(Number(fileId));
    }
}

async function flushPendingNoGpsAssociationPrompt() {
    const ids = window._pendingNoGpsAssociationFileIds || [];
    window._pendingNoGpsAssociationFileIds = [];
    if (!ids.length) return;
    await promptNoGpsPhotoAssociation(ids);
}

async function setPhotoWhitePaintMark(fileId, enabled) {
    const fid = Number(fileId);
    if (!Number.isFinite(fid)) return;
    const photos = (window.photosModule && window.photosModule.savedPhotos) || [];
    const photo = photos.find((p) => Number(p.fileId) === fid);
    const tagMod = window.photoTagsModule;
    let tags = tagMod && typeof tagMod.getPhotoTags === 'function' ? tagMod.getPhotoTags(photo || {}) : [];
    if (enabled) {
        if (tagMod && !tagMod.photoTagsIncludeWhitePaint(tags)) {
            tags = tags.concat([tagMod.WHITE_PAINT_CANONICAL || 'White Paint']);
        }
    } else if (tagMod) {
        tags = tags.filter((t) => !tagMod.photoTagsIncludeWhitePaint([t]));
    }
    await patchPhotoServerFields(fid, { tags });
    if (photo) {
        photo.tags = tags;
        photo.hasWhitePaintMark = !!enabled;
        if (!photo.exifData || typeof photo.exifData !== 'object') photo.exifData = {};
        photo.exifData.hasWhitePaintMark = !!enabled;
        if (window.photosModule && typeof window.photosModule.savePhotos === 'function') {
            window.photosModule.savePhotos();
        }
    }
    if (window.refreshDataWindow) window.refreshDataWindow();
}

window.photoTicketAssociationModule = {
    PHOTO_RECENT_DAYS_ALL,
    TICKET_PHOTO_RECENT_DAYS_OPTIONS,
    TICKET_PHOTO_RECENT_DAYS_DEFAULT,
    normalizeTicketPhotoRecentDays,
    formatPhotoRecentDaysLabel,
    getTicketPhotoRecentDaysPreference,
    photoHasCoordinates,
    photoHasWhitePaintMark,
    photoMayHaveWhitePaintTag,
    getPhotoAssociatedTicketId,
    photoIsAssociatedNoGpsForTicket,
    photoMatchesRecentWindow,
    listAssociatedNoGpsPhotosForTicket,
    associatePhotosWithTicket,
    cancelPhotoTicketAssociationPick,
    startPhotoTicketAssociationPick,
    promptNoGpsPhotoAssociation,
    associatePhotoFromManageData,
    handlePostUploadNoGps,
    flushPendingNoGpsAssociationPrompt,
    setPhotoWhitePaintMark,
};

window.associatePhotoFromManageData = associatePhotoFromManageData;
