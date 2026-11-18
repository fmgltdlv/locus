/**
 * DIRT report nearby-photo gallery picker and scope helpers.
 */
(function () {
    const DIRT_NEARBY_RADIUS_M = 100;

    function tr(text) {
        return typeof window.t === 'function' ? window.t(text) : text;
    }

    function escapeHtml(s) {
        if (window.htmlEscapeModule && typeof window.htmlEscapeModule.escapeHtml === 'function') {
            return window.htmlEscapeModule.escapeHtml(s);
        }
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function getSavedPhotos() {
        const mod = window.photosModule;
        return mod && Array.isArray(mod.savedPhotos) ? mod.savedPhotos : [];
    }

    function getPhotoLatLng(photo) {
        if (!photo) return null;
        if (photo.latlng && Number.isFinite(Number(photo.latlng.lat)) && Number.isFinite(Number(photo.latlng.lng))) {
            return { lat: Number(photo.latlng.lat), lng: Number(photo.latlng.lng) };
        }
        if (Number.isFinite(Number(photo.lat)) && Number.isFinite(Number(photo.lng))) {
            return { lat: Number(photo.lat), lng: Number(photo.lng) };
        }
        const exif = photo.exifData;
        if (exif && Number.isFinite(Number(exif.gpsLat)) && Number.isFinite(Number(exif.gpsLng))) {
            return { lat: Number(exif.gpsLat), lng: Number(exif.gpsLng) };
        }
        return null;
    }

    function haversineMeters(lat1, lng1, lat2, lng2) {
        const geo = window.geoGpsAverage;
        if (geo && typeof geo.haversineDistanceMeters === 'function') {
            return geo.haversineDistanceMeters({ lat: lat1, lng: lng1 }, { lat: lat2, lng: lng2 });
        }
        const R = 6371000;
        const toRad = function (d) {
            return (d * Math.PI) / 180;
        };
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function filterPhotosWithinRadiusMeters(photos, centerLat, centerLng, radiusM) {
        if (!Array.isArray(photos) || !Number.isFinite(centerLat) || !Number.isFinite(centerLng)) return [];
        return photos.filter(function (photo) {
            const pt = getPhotoLatLng(photo);
            if (!pt) return false;
            return haversineMeters(centerLat, centerLng, pt.lat, pt.lng) <= radiusM;
        });
    }

    function applyTicketPhotoRecentWindowFilter(photos) {
        const mod = window.photoTicketAssociationModule;
        if (!mod || typeof mod.photoMatchesRecentWindow !== 'function') return photos || [];
        return (photos || []).filter(function (p) {
            return mod.photoMatchesRecentWindow(p);
        });
    }

    function listAssociatedNoGpsPhotosForTicket(ticket) {
        const imp = window.ticketImporterModule;
        if (imp && typeof imp.listAssociatedNoGpsPhotosForTicket === 'function') {
            return imp.listAssociatedNoGpsPhotosForTicket(ticket);
        }
        const mod = window.photoTicketAssociationModule;
        if (mod && typeof mod.listAssociatedNoGpsPhotosForTicket === 'function') {
            return mod.listAssociatedNoGpsPhotosForTicket(ticket);
        }
        return [];
    }

    function mergePhotosByFileId(geoPhotos, extraPhotos) {
        const seen = new Set();
        const out = [];
        (geoPhotos || []).concat(extraPhotos || []).forEach(function (p) {
            if (!p) return;
            const key = p.fileId != null ? 'f:' + String(p.fileId) : p.id != null ? 'i:' + String(p.id) : null;
            if (!key || seen.has(key)) return;
            seen.add(key);
            out.push(p);
        });
        return out;
    }

    function sortPhotosNewestFirst(photos) {
        return (photos || []).slice().sort(function (a, b) {
            const ta = a && a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const tb = b && b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return tb - ta;
        });
    }

    function resolveDirtGalleryTicket() {
        if (window.dirtReportEditingTicket) return window.dirtReportEditingTicket;
        if (window.dirtReportTicketStub) return window.dirtReportTicketStub;
        const tickets = window.ORG_TICKETS || [];
        let selectedId = null;
        if (window.ticketsModule) {
            if (typeof window.ticketsModule.selectedTicketId === 'function') {
                selectedId = window.ticketsModule.selectedTicketId();
            } else if (window.ticketsModule.selectedTicketId) {
                selectedId = window.ticketsModule.selectedTicketId;
            }
        }
        if (!selectedId && window.selectedTicketId) selectedId = window.selectedTicketId;
        if (selectedId != null && selectedId !== '') {
            const eq =
                typeof window.ticketIdEquals === 'function'
                    ? window.ticketIdEquals
                    : function (a, b) {
                          return String(a) === String(b);
                      };
            const ticket = tickets.find(function (t) {
                return eq(t.id, selectedId);
            });
            if (ticket) return ticket;
        }
        return null;
    }

    function getDirtReportLocationFromForm() {
        const latEl = document.getElementById('dirtLocationLat');
        const lngEl = document.getElementById('dirtLocationLng');
        const lat = latEl && latEl.value !== '' ? Number(latEl.value) : NaN;
        const lng = lngEl && lngEl.value !== '' ? Number(lngEl.value) : NaN;
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            return { lat: lat, lng: lng };
        }
        return null;
    }

    function getNearbyPhotosForDirtReport(ticket, report, options) {
        options = options || {};
        const resolvedTicket = ticket || resolveDirtGalleryTicket();
        const reportLocation =
            report &&
            report.location &&
            Number.isFinite(Number(report.location.lat)) &&
            Number.isFinite(Number(report.location.lng))
                ? { lat: Number(report.location.lat), lng: Number(report.location.lng) }
                : getDirtReportLocationFromForm();

        let geoPhotos = [];
        let reason = null;

        if (resolvedTicket && resolvedTicket.polygon && resolvedTicket.polygon.coordinates) {
            const getInPoly =
                window.ticketsModule && typeof window.ticketsModule.getPhotosInTicketPolygon === 'function'
                    ? window.ticketsModule.getPhotosInTicketPolygon.bind(window.ticketsModule)
                    : null;
            geoPhotos = getInPoly ? getInPoly(resolvedTicket.polygon) : [];
        } else if (reportLocation) {
            geoPhotos = filterPhotosWithinRadiusMeters(
                getSavedPhotos(),
                reportLocation.lat,
                reportLocation.lng,
                options.radiusM != null ? options.radiusM : DIRT_NEARBY_RADIUS_M
            );
        } else if (resolvedTicket && window.ticketsModule && typeof window.ticketsModule.ticketMapAnchorLatLng === 'function') {
            const anchor = window.ticketsModule.ticketMapAnchorLatLng(resolvedTicket);
            if (anchor && Number.isFinite(anchor.lat) && Number.isFinite(anchor.lng)) {
                geoPhotos = filterPhotosWithinRadiusMeters(
                    getSavedPhotos(),
                    anchor.lat,
                    anchor.lng,
                    options.radiusM != null ? options.radiusM : DIRT_NEARBY_RADIUS_M
                );
            }
        } else {
            reason = 'noScope';
        }

        geoPhotos = applyTicketPhotoRecentWindowFilter(geoPhotos);

        if (resolvedTicket && resolvedTicket.id != null) {
            const associated = applyTicketPhotoRecentWindowFilter(listAssociatedNoGpsPhotosForTicket(resolvedTicket));
            geoPhotos = mergePhotosByFileId(geoPhotos, associated);
        }

        geoPhotos = sortPhotosNewestFirst(geoPhotos);

        return {
            photos: geoPhotos,
            reason: reason,
            ticket: resolvedTicket,
            location: reportLocation,
        };
    }

    function filterRestakedPhotos(photos) {
        const utils = window.photoStakeUtils;
        if (utils && typeof utils.filterRestakedPhotos === 'function') {
            return utils.filterRestakedPhotos(photos);
        }
        return (photos || []).filter(function (p) {
            return utils && typeof utils.isRestakedPhoto === 'function' && utils.isRestakedPhoto(p);
        });
    }

    function formatPhotoListDate(photo) {
        if (window.photoCanvasUtils && typeof window.photoCanvasUtils.formatPhotoStampDateTime === 'function') {
            return window.photoCanvasUtils.formatPhotoStampDateTime(photo && photo.createdAt);
        }
        if (typeof window.formatRecordedDateTime === 'function') {
            return window.formatRecordedDateTime(photo && photo.createdAt, '');
        }
        return '';
    }

    function getMatchedShotBadgeHtml(photo) {
        const utils = window.photoStakeUtils;
        if (!utils || typeof utils.isRestakedPhoto !== 'function' || !utils.isRestakedPhoto(photo)) {
            return '';
        }
        let label = tr('Matched shot');
        const ref = typeof utils.resolveStakeReferencePhoto === 'function' ? utils.resolveStakeReferencePhoto(photo) : null;
        if (ref && ref.fileName) {
            label += ' · ' + tr('of {name}').replace('{name}', ref.fileName);
        }
        return '<span class="dirt-photo-matched-badge">' + escapeHtml(label) + '</span>';
    }

    var galleryState = {
        filter: 'all',
        photos: [],
        selected: new Set(),
        loading: false,
    };

    function getAttachedFileIds() {
        const ids = window.dirtReportCapturedPhotoFileIds;
        return Array.isArray(ids) ? ids.slice() : [];
    }

    function syncGallerySelectionFromAttached() {
        galleryState.selected = new Set(
            getAttachedFileIds()
                .map(function (id) {
                    return Number(id);
                })
                .filter(function (n) {
                    return Number.isFinite(n);
                })
        );
    }

    function getFilteredGalleryPhotos() {
        if (galleryState.filter === 'restaked') {
            return filterRestakedPhotos(galleryState.photos);
        }
        return galleryState.photos;
    }

    async function hydrateGalleryThumb(img, fileId) {
        if (!img || fileId == null) return;
        const mod = window.photosModule;
        if (!mod || typeof mod.getPhotoThumbnailObjectUrlCached !== 'function') return;
        try {
            const url = await mod.getPhotoThumbnailObjectUrlCached(fileId);
            if (url) img.src = url;
        } catch (_) {
            /* ignore */
        }
    }

    function renderGalleryGrid() {
        const grid = document.getElementById('dirtReportPhotoGalleryGrid');
        const empty = document.getElementById('dirtReportPhotoGalleryEmpty');
        if (!grid) return;

        const photos = getFilteredGalleryPhotos();
        if (!photos.length) {
            grid.innerHTML = '';
            if (empty) {
                empty.hidden = false;
                if (galleryState.reason === 'noScope') {
                    empty.textContent = tr('Set report location on map or use a ticket with a dig site');
                } else if (galleryState.filter === 'restaked') {
                    empty.textContent = tr(
                        'No matched shots nearby — try All nearby or use Match on an existing photo'
                    );
                } else {
                    empty.textContent = tr('No photos found nearby');
                }
            }
            return;
        }

        if (empty) empty.hidden = true;

        grid.innerHTML = photos
            .map(function (photo) {
                const fileId = photo.fileId;
                const checked = fileId != null && galleryState.selected.has(Number(fileId)) ? ' checked' : '';
                const name = photo.fileName || photo.originalFileName || tr('Photo');
                const badge = getMatchedShotBadgeHtml(photo);
                return (
                    '<label class="dirt-gallery-card' +
                    (checked ? ' is-selected' : '') +
                    '">' +
                    '<input type="checkbox" class="dirt-gallery-card-check" data-file-id="' +
                    escapeHtml(String(fileId)) +
                    '"' +
                    checked +
                    ' />' +
                    '<span class="dirt-gallery-card-thumb-wrap">' +
                    '<img class="dirt-gallery-card-thumb" alt="" data-file-id="' +
                    escapeHtml(String(fileId)) +
                    '" />' +
                    badge +
                    '</span>' +
                    '<span class="dirt-gallery-card-name">' +
                    escapeHtml(name) +
                    '</span>' +
                    '</label>'
                );
            })
            .join('');

        grid.querySelectorAll('.dirt-gallery-card-check').forEach(function (input) {
            input.addEventListener('change', function () {
                const fid = Number(input.getAttribute('data-file-id'));
                if (!Number.isFinite(fid)) return;
                if (input.checked) galleryState.selected.add(fid);
                else galleryState.selected.delete(fid);
                const card = input.closest('.dirt-gallery-card');
                if (card) card.classList.toggle('is-selected', input.checked);
            });
        });

        grid.querySelectorAll('.dirt-gallery-card-thumb').forEach(function (img) {
            const fid = Number(img.getAttribute('data-file-id'));
            void hydrateGalleryThumb(img, fid);
        });
    }

    function setGalleryFilter(filter) {
        galleryState.filter = filter === 'restaked' ? 'restaked' : 'all';
        const allBtn = document.getElementById('dirtReportPhotoGalleryFilterAll');
        const restBtn = document.getElementById('dirtReportPhotoGalleryFilterRestaked');
        if (allBtn) allBtn.setAttribute('aria-pressed', galleryState.filter === 'all' ? 'true' : 'false');
        if (restBtn) restBtn.setAttribute('aria-pressed', galleryState.filter === 'restaked' ? 'true' : 'false');
        renderGalleryGrid();
    }

    async function loadGalleryPhotos() {
        const spinner = document.getElementById('dirtReportPhotoGalleryLoading');
        if (spinner) spinner.hidden = false;

        if (window.photosModule && typeof window.photosModule.ensureManageDataPhotosLoaded === 'function') {
            try {
                await window.photosModule.ensureManageDataPhotosLoaded();
            } catch (err) {
                console.warn('[dirtReportPhotoGallery] ensureManageDataPhotosLoaded:', err);
            }
        }

        const scope = getNearbyPhotosForDirtReport();
        galleryState.photos = scope.photos;
        galleryState.reason = scope.reason;
        syncGallerySelectionFromAttached();
        if (spinner) spinner.hidden = true;
        renderGalleryGrid();
    }

    function closeDirtReportPhotoGalleryModal() {
        const modal = document.getElementById('dirtReportPhotoGalleryModal');
        if (modal) {
            modal.style.display = 'none';
            modal.setAttribute('aria-hidden', 'true');
        }
    }

    function attachSelectedGalleryPhotos() {
        if (!Array.isArray(window.dirtReportCapturedPhotoFileIds)) {
            window.dirtReportCapturedPhotoFileIds = [];
        }
        const scopeIds = new Set(
            galleryState.photos
                .map(function (p) {
                    return Number(p.fileId);
                })
                .filter(function (n) {
                    return Number.isFinite(n);
                })
        );
        const selected = galleryState.selected;
        window.dirtReportCapturedPhotoFileIds = window.dirtReportCapturedPhotoFileIds.filter(function (id) {
            const fid = Number(id);
            if (!scopeIds.has(fid)) return true;
            return selected.has(fid);
        });
        selected.forEach(function (fid) {
            if (!window.dirtReportCapturedPhotoFileIds.includes(fid)) {
                window.dirtReportCapturedPhotoFileIds.push(fid);
            }
        });
        if (typeof refreshDirtCapturedPhotosList === 'function') {
            refreshDirtCapturedPhotosList();
        }
        if (typeof syncDirtLocationFromAttachedPhotos === 'function') {
            void syncDirtLocationFromAttachedPhotos();
        }
        closeDirtReportPhotoGalleryModal();
    }

    var galleryBound = false;

    function ensureGalleryModalBound() {
        if (galleryBound) return;
        galleryBound = true;

        const modal = document.getElementById('dirtReportPhotoGalleryModal');
        if (modal) {
            modal.addEventListener('click', function (e) {
                if (e.target === modal) closeDirtReportPhotoGalleryModal();
            });
        }

        const closeBtn = document.getElementById('dirtReportPhotoGalleryClose');
        if (closeBtn) closeBtn.addEventListener('click', closeDirtReportPhotoGalleryModal);

        const cancelBtn = document.getElementById('dirtReportPhotoGalleryCancel');
        if (cancelBtn) cancelBtn.addEventListener('click', closeDirtReportPhotoGalleryModal);

        const attachBtn = document.getElementById('dirtReportPhotoGalleryAttach');
        if (attachBtn) attachBtn.addEventListener('click', attachSelectedGalleryPhotos);

        const allBtn = document.getElementById('dirtReportPhotoGalleryFilterAll');
        if (allBtn) allBtn.addEventListener('click', function () {
            setGalleryFilter('all');
        });

        const restBtn = document.getElementById('dirtReportPhotoGalleryFilterRestaked');
        if (restBtn) restBtn.addEventListener('click', function () {
            setGalleryFilter('restaked');
        });
    }

    function openDirtReportPhotoGalleryModal() {
        ensureGalleryModalBound();
        const modal = document.getElementById('dirtReportPhotoGalleryModal');
        if (!modal) return;

        galleryState.filter = 'all';
        setGalleryFilter('all');
        modal.style.display = 'flex';
        modal.style.zIndex = '71000';
        modal.setAttribute('aria-hidden', 'false');
        void loadGalleryPhotos();
    }

    window.dirtReportPhotoGalleryModule = {
        getNearbyPhotosForDirtReport: getNearbyPhotosForDirtReport,
        filterRestakedPhotos: filterRestakedPhotos,
        openDirtReportPhotoGalleryModal: openDirtReportPhotoGalleryModal,
        closeDirtReportPhotoGalleryModal: closeDirtReportPhotoGalleryModal,
        getMatchedShotBadgeHtml: getMatchedShotBadgeHtml,
        formatPhotoListDate: formatPhotoListDate,
    };

    window.openDirtReportPhotoGalleryModal = openDirtReportPhotoGalleryModal;
})();
