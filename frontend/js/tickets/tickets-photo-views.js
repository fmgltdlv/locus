/**
 * tickets-photo-views.js — split from tickets-operations-photos.js (Phase F1).
 * Ticket↔photo intersection and popup photo lists.
 * Globals: same window/function names as before (IIFE bundle).
 */
// Get all photos within a ticket polygon or within TICKET_PHOTO_SEARCH_BUFFER (see tableQueries)
function getPhotosInTicketPolygon(ticketPolygon) {
    if (!ticketPolygon || !ticketPolygon.coordinates || !ticketPolygon.coordinates[0]) {
        return [];
    }
    
    // Get all photos
    const photos = window.photosModule?.savedPhotos || [];
    if (photos.length === 0) {
        return [];
    }
    
    // Convert ticket polygon to Leaflet polygon for intersection checks
    let leafletPolygon = null;
    try {
        const coords = ticketPolygon.coordinates[0].map(c => [c[1], c[0]]); // Convert [lng, lat] to [lat, lng]
        leafletPolygon = L.polygon(coords);
    } catch (error) {
        console.error('Error creating Leaflet polygon for photo check:', error);
        return [];
    }
    
    // Use isPointInPolygon from tableQueries module if available
    const isPointInPolygon = window.tableQueriesModule?.isPointInPolygon || function(point, polygon) {
        const latlngs = polygon.getLatLngs()[0];
        let inside = false;
        for (let i = 0, j = latlngs.length - 1; i < latlngs.length; j = i++) {
            const xi = latlngs[i].lng;
            const yi = latlngs[i].lat;
            const xj = latlngs[j].lng;
            const yj = latlngs[j].lat;
            const intersect = ((yi > point.lat) !== (yj > point.lat)) &&
                (point.lng < (xj - xi) * (point.lat - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    };
    
    // Filter photos within polygon
    const photosInPolygon = [];
    photos.forEach(photo => {
        // Check if photo has location (from EXIF or tagged)
        let photoLat = null;
        let photoLng = null;
        
        if (photo.exifData && photo.exifData.gpsLat && photo.exifData.gpsLng) {
            photoLat = photo.exifData.gpsLat;
            photoLng = photo.exifData.gpsLng;
        } else if (photo.latlng && photo.latlng.lat && photo.latlng.lng) {
            photoLat = photo.latlng.lat;
            photoLng = photo.latlng.lng;
        } else if (photo.lat !== undefined && photo.lng !== undefined) {
            photoLat = photo.lat;
            photoLng = photo.lng;
        }
        
        if (photoLat !== null && photoLng !== null) {
            const point = L.latLng(photoLat, photoLng);
            const tqm = window.tableQueriesModule;
            const inArea =
                tqm && typeof tqm.isPointInOrNearTicketPolygon === 'function'
                    ? tqm.isPointInOrNearTicketPolygon(point, leafletPolygon)
                    : leafletPolygon.getBounds().contains(point) && isPointInPolygon(point, leafletPolygon);
            if (inArea) {
                photosInPolygon.push(photo);
            }
        }
    });
    
    return photosInPolygon;
}

function applyTicketPhotoRecentWindowFilter(photos, recentDaysOverride) {
    if (!Array.isArray(photos)) return photos || [];
    const mod = window.photoTicketAssociationModule;
    if (!mod || typeof mod.photoMatchesRecentWindow !== 'function') return photos;
    return photos.filter((p) => mod.photoMatchesRecentWindow(p, recentDaysOverride));
}

function listAssociatedNoGpsPhotosForTicketView(ticket) {
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

function mergeTicketViewPhotos(geoPhotos, extraPhotos) {
    const imp = window.ticketImporterModule;
    if (imp && typeof imp.mergeTicketPhotosByFileId === 'function') {
        return imp.mergeTicketPhotosByFileId(geoPhotos, extraPhotos);
    }
    return (geoPhotos || []).concat(extraPhotos || []);
}

function mapServerSnapMediaToTicketPhoto(m, ticket) {
    const isNoGps = !!(m && (m.associatedNoGps || (m.lat == null && m.lng == null)));
    const photo = {
        id: `server-media-${m.id}`,
        fileId: m.id,
        fileName: m.fileName,
        fileType: m.fileType || 'photo',
        createdAt: m.createdAt,
        thumbnailUrl: m.thumbnailUrl,
        lat: m.lat,
        lng: m.lng,
        hasWhitePaintMark: m.hasWhitePaintMark === true,
        tags:
            window.photoTagsModule && typeof window.photoTagsModule.getPhotoTagsFromMeta === 'function'
                ? window.photoTagsModule.getPhotoTagsFromMeta(m.metadata || m)
                : Array.isArray(m.tags)
                  ? m.tags
                  : m.hasWhitePaintMark === true
                    ? ['White Paint']
                    : [],
    };
    if (isNoGps && ticket) {
        photo.associatedTicketId = ticket.id;
        photo.associatedNoGps = true;
    }
    return photo;
}

function ticketLinkedPhotoIsNoGpsAssociated(photo) {
    if (!photo) return false;
    if (photo.associatedNoGps) return true;
    return photo.lat == null && photo.lng == null && photo.associatedTicketId != null;
}

function ticketPhotosApiCacheForTab(ticket, tab) {
    if (!ticket || !ticket._mapPhotosApiCacheByTab) return null;
    const items = ticket._mapPhotosApiCacheByTab[tab];
    return Array.isArray(items) ? items : null;
}

/** Geo in ticket area + explicitly associated no-GPS (no recent-window filter). */
function resolveTicketLinkedPhotosUnfiltered(ticket) {
    if (!ticket) return [];
    const allApi = ticketPhotosApiCacheForTab(ticket, 'all');
    if (allApi && allApi.length) return allApi.slice();
    const geoPhotos = ticket.polygon ? getPhotosInTicketPolygon(ticket.polygon) : [];
    const associated = listAssociatedNoGpsPhotosForTicketView(ticket);
    return mergeTicketViewPhotos(geoPhotos, associated);
}

function listAllTicketLinkedPhotosUnfiltered(ticket) {
    return resolveTicketLinkedPhotosUnfiltered(ticket);
}

function filterRevisionTicketPhotos(ticket, photos) {
    const imp = window.ticketImporterModule;
    if (!imp || typeof imp.photoCreatedAtMeetsRevisionCutoff !== 'function') return photos || [];
    if (ticket.photoRequirementCutoffPending) return [];
    if (!ticket.photoRequirementCutoffIso) return photos || [];
    const cut = ticket.photoRequirementCutoffIso;
    return (photos || []).filter((p) => imp.photoCreatedAtMeetsRevisionCutoff(p && p.createdAt, cut));
}

/** @param {string} mode 'all' | 'revision' | 'nogps' | 'tag' @param {number} [recentDaysOverride] @param {string} [tagName] tag filter when mode is 'tag' */
function getPhotosInTicketForView(ticket, mode, recentDaysOverride, tagName) {
    if (!ticket) return [];
    const apiTabByMode = { map: 'map', revision: 'compliance', all: 'all', nogps: 'nogps' };
    const apiTab = apiTabByMode[mode];
    if (apiTab) {
        const cached = ticketPhotosApiCacheForTab(ticket, apiTab);
        if (cached && cached.length) {
            if (mode === 'tag' && tagName) {
                const tagMod = window.photoTagsModule;
                const matches =
                    tagMod && typeof tagMod.photoMatchesTagFilter === 'function'
                        ? (p) => tagMod.photoMatchesTagFilter(p, tagName)
                        : () => false;
                return applyTicketPhotoRecentWindowFilter(cached.filter(matches), recentDaysOverride);
            }
            return applyTicketPhotoRecentWindowFilter(cached, recentDaysOverride);
        }
    }
    if (mode === 'map') {
        return [];
    }
    if (mode === 'tag' && tagName) {
        const tagMod = window.photoTagsModule;
        const matches =
            tagMod && typeof tagMod.photoMatchesTagFilter === 'function'
                ? (p) => tagMod.photoMatchesTagFilter(p, tagName)
                : (p) => false;
        const marked = listAllTicketLinkedPhotosUnfiltered(ticket).filter(matches);
        return applyTicketPhotoRecentWindowFilter(marked, recentDaysOverride);
    }
    if (mode === 'nogps') {
        const local = listAssociatedNoGpsPhotosForTicketView(ticket);
        return applyTicketPhotoRecentWindowFilter(local, recentDaysOverride);
    }

    const allLinked = resolveTicketLinkedPhotosUnfiltered(ticket);
    let geoPhotos = allLinked.filter((p) => !ticketLinkedPhotoIsNoGpsAssociated(p));
    let associated = allLinked.filter((p) => ticketLinkedPhotoIsNoGpsAssociated(p));

    geoPhotos = applyTicketPhotoRecentWindowFilter(geoPhotos, recentDaysOverride);

    if (mode === 'all' || !mode) {
        associated = applyTicketPhotoRecentWindowFilter(associated, recentDaysOverride);
        return mergeTicketViewPhotos(geoPhotos, associated);
    }

    const revisionGeo = filterRevisionTicketPhotos(ticket, geoPhotos);
    associated = applyTicketPhotoRecentWindowFilter(associated, recentDaysOverride);
    const revisionAssociated = filterRevisionTicketPhotos(ticket, associated);
    return mergeTicketViewPhotos(revisionGeo, revisionAssociated);
}

/**
 * Counts for ticket popup/hub photo summary aligned with the user's photo date window.
 * @returns {{ visibleInWindow: number, hiddenByWindow: number, totalInArea: number, windowLabel: string, recentDays: number }}
 */
function getTicketPhotoWindowDisplayStats(ticket) {
    if (!ticket) {
        return { visibleInWindow: 0, hiddenByWindow: 0, totalInArea: 0, windowLabel: 'Last 90 days', recentDays: 90 };
    }
    const mod = window.photoTicketAssociationModule;
    const recentDays =
        mod && typeof mod.getTicketPhotoRecentDaysPreference === 'function'
            ? mod.getTicketPhotoRecentDaysPreference()
            : 90;
    const allDays = mod && mod.PHOTO_RECENT_DAYS_ALL != null ? mod.PHOTO_RECENT_DAYS_ALL : 0;
    const windowLabel =
        mod && typeof mod.formatPhotoRecentDaysLabel === 'function'
            ? mod.formatPhotoRecentDaysLabel(recentDays)
            : recentDays === allDays
              ? 'All photos'
              : `Last ${recentDays} days`;
    const allInArea = listAllTicketLinkedPhotosUnfiltered(ticket);
    const totalInArea = allInArea.length;
    const matchesRecent =
        mod && typeof mod.photoMatchesRecentWindow === 'function'
            ? (p) => mod.photoMatchesRecentWindow(p, recentDays)
            : () => true;
    const visibleInWindow =
        recentDays === allDays ? totalInArea : allInArea.filter((p) => matchesRecent(p)).length;
    const hiddenByWindow =
        recentDays === allDays ? 0 : allInArea.filter((p) => !matchesRecent(p)).length;
    return { visibleInWindow, hiddenByWindow, totalInArea, windowLabel, recentDays };
}

/** Newest photo for ticket popup preview thumbnail (revision subset, else all-in-area). */
function getTicketPopupPreviewPhoto(ticket) {
    if (!ticket) return null;
    let list = getPhotosInTicketForView(ticket, 'revision');
    if (!list || !list.length) {
        list = getPhotosInTicketForView(ticket, 'all');
    }
    if (!list || !list.length) return null;
    const imp = window.ticketImporterModule;
    const getMs =
        imp && typeof imp.getPhotoCreatedAtMs === 'function'
            ? (p) => imp.getPhotoCreatedAtMs(p)
            : (p) => {
                  if (p.createdAt) {
                      const t = new Date(p.createdAt).getTime();
                      return Number.isNaN(t) ? 0 : t;
                  }
                  return 0;
              };
    return [...list].sort((a, b) => (getMs(b) || 0) - (getMs(a) || 0))[0];
}

async function fetchTicketPhotosFromApi(ticket, tab) {
    if (!ticket || ticket.id == null || !window.authModule) return [];
    const orgId =
        ticket.organizationId != null
            ? ticket.organizationId
            : window.orgSelectorModule && window.orgSelectorModule.getCurrentOrgId
              ? window.orgSelectorModule.getCurrentOrgId()
              : null;
    if (!orgId) return [];
    const apiBase = window.authModule.API_BASE || '/api';
    const headers =
        typeof window.authModule.getAuthHeaders === 'function' ? window.authModule.getAuthHeaders() : {};
    const params = new URLSearchParams({
        organizationId: String(orgId),
        ticketId: String(ticket.id),
        tab: tab || 'map',
        page: '1',
        limit: '200',
    });
    const res = await fetch(`${apiBase}/data/media/photos/for-ticket?${params.toString()}`, { headers });
    if (!res.ok) return [];
    const data = await res.json();
    const baseUrl =
        window.authModule.getApiBaseForMedia && window.authModule.getApiBaseForMedia()
            ? window.authModule.getApiBaseForMedia()
            : window.API_BASE_URL || window.location.origin;
    return (data.items || []).map((m) =>
        mapServerSnapMediaToTicketPhoto(
            {
                id: m.id,
                fileName: m.fileName,
                createdAt: m.createdAt,
                thumbnailUrl: m.thumbnailUrl,
                lat: m.lat,
                lng: m.lng,
                associatedNoGps: m.associatedNoGps,
            },
            ticket
        )
    );
}

async function ensureTicketPhotosFromApi(ticket, tab) {
    if (!ticket) return [];
    const cacheKey = tab || 'map';
    if (!ticket._mapPhotosApiCacheByTab) ticket._mapPhotosApiCacheByTab = {};
    if (Array.isArray(ticket._mapPhotosApiCacheByTab[cacheKey])) {
        return ticket._mapPhotosApiCacheByTab[cacheKey];
    }
    const items = await fetchTicketPhotosFromApi(ticket, cacheKey);
    ticket._mapPhotosApiCacheByTab[cacheKey] = items;
    if (typeof window.ticketsModule?.refreshOpenTicketPopupPhotoCounts === 'function') {
        window.ticketsModule.refreshOpenTicketPopupPhotoCounts(ticket);
    }
    if (window.ticketHubModule && typeof window.ticketHubModule.redrawIfOpen === 'function') {
        window.ticketHubModule.redrawIfOpen();
    }
    return items;
}

// Show popup with all photos in ticket polygon (or subset for this revision)
async function showTicketPhotos(ticketId, ticketNumber) {
    const ticket = (window.ORG_TICKETS || []).find(
        t => ticketIdEquals(t.id, ticketId) || t.ticketNumber === ticketNumber
    );
    if (!ticket || !ticket.polygon) {
        await appAlert('Ticket not found or has no polygon');
        return;
    }
    const imp = window.ticketImporterModule;
    const isPosrTicket =
        imp && typeof imp.isPosrPublicImportTicket === 'function' && imp.isPosrPublicImportTicket(ticket);
    const prefetchTabs = ['map', 'all', 'nogps'];
    if (!isPosrTicket) prefetchTabs.push('compliance');
    await Promise.all(prefetchTabs.map((tab) => ensureTicketPhotosFromApi(ticket, tab)));
    let viewMode = 'map';
    let activeTagName = '';

    const modal = document.createElement('div');
    modal.className = 'ticket-photos-modal ticket-photos-side-gallery';

    const modalContent = document.createElement('div');
    modalContent.className = 'ticket-photos-side-gallery__panel';

    const header = document.createElement('div');
    header.style.cssText = 'display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1rem; border-bottom: 1px solid var(--app-bg-muted); padding-bottom: 1rem; gap: 1rem; flex-wrap: wrap;';

    const title = document.createElement('h2');
    title.style.cssText = 'color: var(--app-text-inverse); font-size: 1.5rem; font-weight: 600; margin: 0; flex: 1; min-width: 200px;';

    const closeButton = document.createElement('button');
    closeButton.textContent = 'x';
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.style.cssText = 'background: var(--app-danger); color: var(--app-text-inverse); border: none; border-radius: 0.25rem; width: 2rem; height: 2rem; font-size: 1.5rem; cursor: pointer; display: flex; align-items: center; justify-content: center; line-height: 1; flex-shrink: 0;';
    closeButton.onclick = () => {
        if (typeof modal._ticketPhotosGalleryCleanup === 'function') {
            modal._ticketPhotosGalleryCleanup();
            modal._ticketPhotosGalleryCleanup = null;
        }
        modal.remove();
    };
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeButton.click();
        }
    });
    modalContent.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    const photoAssocMod = window.photoTicketAssociationModule;
    const recentDaysAll =
        photoAssocMod && photoAssocMod.PHOTO_RECENT_DAYS_ALL != null ? photoAssocMod.PHOTO_RECENT_DAYS_ALL : 0;
    let modalRecentDays =
        photoAssocMod && typeof photoAssocMod.getTicketPhotoRecentDaysPreference === 'function'
            ? photoAssocMod.getTicketPhotoRecentDaysPreference()
            : 90;

    const getModalPhotos = (mode) => {
        if (mode === 'tag' && activeTagName) {
            return getPhotosInTicketForView(ticket, 'tag', modalRecentDays, activeTagName);
        }
        return getPhotosInTicketForView(ticket, mode, modalRecentDays);
    };

    const modalWindowSuffix = () =>
        modalRecentDays === recentDaysAll ? '' : ` (last ${modalRecentDays} days)`;

    const updateTitle = (mode) => {
        const n = getModalPhotos(mode).length;
        const countBit = `(${n} photo${n === 1 ? '' : 's'})`;
        const suffix = modalWindowSuffix();
        if (mode === 'tag' && activeTagName) {
            title.textContent = `${activeTagName}${suffix} - Ticket ${ticketNumber} ${countBit}`;
        } else if (mode === 'revision') {
            title.textContent = `This Rev${suffix} - Ticket ${ticketNumber} ${countBit}`;
        } else if (mode === 'map') {
            title.textContent = `Geotagged${suffix} - Ticket ${ticketNumber} ${countBit}`;
        } else if (mode === 'nogps') {
            title.textContent = `No GPS${suffix} - Ticket ${ticketNumber} ${countBit}`;
        } else if (modalRecentDays === recentDaysAll) {
            title.textContent = `All in area - ${ticketNumber} ${countBit}`;
        } else {
            title.textContent = `All in area (last ${modalRecentDays} days) - ${ticketNumber} ${countBit}`;
        }
    };

    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin-bottom: 1rem;';
    const btnAll = document.createElement('button');
    btnAll.type = 'button';
    const btnRev = document.createElement('button');
    btnRev.type = 'button';
    const btnNoGps = document.createElement('button');
    btnNoGps.type = 'button';
    [btnAll, btnRev, btnNoGps].forEach((b) => {
        b.style.cssText =
            'padding: 0.4rem 0.75rem; border-radius: 0.25rem; border: 1px solid var(--app-border); cursor: pointer; font-size: 0.8rem; background: var(--app-bg-surface); color: var(--app-text-inverse);';
    });

    const tagSelect = document.createElement('select');
    tagSelect.title = 'Filter by tag';
    tagSelect.setAttribute('aria-label', 'Filter photos by tag');
    tagSelect.style.cssText =
        'padding: 0.35rem 0.5rem; border-radius: 0.25rem; border: 1px solid var(--app-border); font-size: 0.8rem; background: var(--app-bg-surface); color: var(--app-text-inverse);';

    const refreshTagSelectOptions = () => {
        const allPhotos = getPhotosInTicketForView(ticket, 'all', modalRecentDays);
        const tagMod = window.photoTagsModule;
        const tags =
            tagMod && typeof tagMod.collectDistinctTagsFromPhotos === 'function'
                ? tagMod.collectDistinctTagsFromPhotos(allPhotos)
                : [];
        const prev = tagSelect.value;
        tagSelect.innerHTML = '';
        const optAll = document.createElement('option');
        optAll.value = '';
        optAll.textContent = 'All tags';
        tagSelect.appendChild(optAll);
        tags.forEach((tag) => {
            const count = allPhotos.filter((p) =>
                tagMod && typeof tagMod.photoMatchesTagFilter === 'function'
                    ? tagMod.photoMatchesTagFilter(p, tag)
                    : false
            ).length;
            if (count < 1) return;
            const opt = document.createElement('option');
            opt.value = tag;
            opt.textContent = `${tag} (${count})`;
            tagSelect.appendChild(opt);
        });
        if (prev && Array.from(tagSelect.options).some((o) => o.value === prev)) {
            tagSelect.value = prev;
        } else {
            tagSelect.value = '';
            if (viewMode === 'tag') {
                viewMode = 'all';
                activeTagName = '';
            }
        }
    };

    const refreshTabCounts = () => {
        btnAll.textContent = `Geotagged (${getModalPhotos('map').length})`;
        if (!isPosrTicket) {
            btnRev.textContent = `This Rev (${getModalPhotos('revision').length})`;
        }
        btnNoGps.textContent = `All in area (${getModalPhotos('all').length})`;
        refreshTagSelectOptions();
    };
    refreshTabCounts();

    const recentSelect = document.createElement('select');
    recentSelect.title = 'Temporary date window for this view';
    recentSelect.setAttribute('aria-label', 'Photo date window');
    recentSelect.style.cssText =
        'margin-left: auto; padding: 0.35rem 0.5rem; border-radius: 0.25rem; border: 1px solid var(--app-border); font-size: 0.8rem; background: var(--app-bg-surface); color: var(--app-text-inverse); align-self: center;';
    const windowOptionDays =
        photoAssocMod && Array.isArray(photoAssocMod.TICKET_PHOTO_RECENT_DAYS_OPTIONS)
            ? photoAssocMod.TICKET_PHOTO_RECENT_DAYS_OPTIONS
            : [90, 180, 365];
    windowOptionDays.forEach((days) => {
        const opt = document.createElement('option');
        opt.value = String(days);
        opt.textContent = `Last ${days} days`;
        if (days === modalRecentDays) opt.selected = true;
        recentSelect.appendChild(opt);
    });
    const optAll = document.createElement('option');
    optAll.value = String(recentDaysAll);
    optAll.textContent = 'All photos';
    if (modalRecentDays === recentDaysAll) optAll.selected = true;
    recentSelect.appendChild(optAll);

    if (!isPosrTicket && ticket.photoRequirementCutoffPending) {
        const note = document.createElement('div');
        note.textContent = 'This revision: cutoff pending (no USAN sync yet) - no photos in this view.';
        note.style.cssText = 'color: #facc15; font-size: 0.8rem; width: 100%;';
        toolbar.appendChild(note);
    }

    const photosGrid = document.createElement('div');
    photosGrid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 1rem;';

    const appendOnePhoto = (photo, galleryIndex, galleryList) => {
        const photoCard = document.createElement('div');
        photoCard.style.cssText = 'background: var(--app-bg-surface); border: 1px solid var(--app-border); border-radius: 0.375rem; padding: 1rem; display: flex; flex-direction: column; gap: 0.5rem;';

        const photoImgWrap = document.createElement('div');
        photoImgWrap.className = 'ticket-photos-gallery-img-wrap';

        const photoImg = document.createElement('img');
        photoImg.className = 'ticket-photos-gallery-img server-photo-image-hidden';
        {
            const altBase = photo.fileName || 'Photo';
            photoImg.alt =
                typeof window.truncateImageNameForDisplay === 'function'
                    ? window.truncateImageNameForDisplay(altBase) || altBase
                    : altBase.length > 10
                      ? altBase.slice(0, 10) + '...'
                      : altBase;
        }
        const openPhotoFromGallery = () => {
            const galleryContext =
                galleryList && galleryList.length >= 2
                    ? { gallery: galleryList, galleryIndex }
                    : null;
            if (window.openPhotoViewer) window.openPhotoViewer(photo, photo.fileName, galleryContext);
            else if (photoImg.src) window.open(photoImg.src, '_blank');
        };
        photoImgWrap.onclick = openPhotoFromGallery;

        photoImgWrap.appendChild(photoImg);
        if (photo.fileId && window.photosModule && window.photosModule.setServerPhotoImageSources) {
            photoImg.setAttribute('data-file-id', String(photo.fileId));
            photoImg.setAttribute('data-use-thumbnail', '1');
            window.photosModule.setServerPhotoImageSources(photoImgWrap);
        } else {
            const imageUrl = window.photosModule?.getPhotoImageUrl ? window.photosModule.getPhotoImageUrl(photo) : photo.imageUrl;
            if (imageUrl) {
                const status = document.createElement('span');
                status.className = 'server-photo-image-status';
                status.setAttribute('role', 'status');
                status.setAttribute('aria-live', 'polite');
                status.innerHTML =
                    '<span class="server-photo-image-spinner" aria-hidden="true"></span>' +
                    '<span class="server-photo-image-fallback" aria-hidden="true" hidden>📷</span>';
                photoImgWrap.classList.add('server-photo-image-status-host');
                photoImgWrap.setAttribute('aria-busy', 'true');
                photoImgWrap.appendChild(status);
                photoImg.classList.add('server-photo-image-hidden');
                photoImg.onload = () => {
                    photoImg.classList.remove('server-photo-image-hidden');
                    status.hidden = true;
                    photoImgWrap.removeAttribute('aria-busy');
                };
                photoImg.onerror = () => {
                    photoImg.classList.add('server-photo-image-hidden');
                    photoImg.removeAttribute('src');
                    const spinner = status.querySelector('.server-photo-image-spinner');
                    const fallback = status.querySelector('.server-photo-image-fallback');
                    if (spinner) spinner.hidden = true;
                    if (fallback) fallback.hidden = false;
                    photoImgWrap.removeAttribute('aria-busy');
                };
                photoImg.src = imageUrl;
            }
        }

        const photoName = document.createElement('div');
        const pn = photo.fileName || 'Photo';
        photoName.textContent =
            typeof window.truncateImageNameForDisplay === 'function'
                ? window.truncateImageNameForDisplay(pn) || pn
                : pn.length > 10
                  ? pn.slice(0, 10) + '...'
                  : pn;
        photoName.style.cssText = 'color: var(--app-text-inverse); font-weight: 600; font-size: 0.875rem;';

        const photoInfo = document.createElement('div');
        photoInfo.style.cssText = 'color: var(--app-text-secondary); font-size: 0.75rem;';

        let locationInfo = 'No location';
        if (photo.exifData && photo.exifData.gpsLat && photo.exifData.gpsLng) {
            locationInfo = `${formatLatLng(photo.exifData.gpsLat, photo.exifData.gpsLng)} (${photo.exifData.gpsSource || 'EXIF'})`;
        } else if (photo.latlng && photo.latlng.lat && photo.latlng.lng) {
            locationInfo = `${formatLatLng(photo.latlng.lat, photo.latlng.lng)} (Manual)`;
        } else if (photo.lat !== undefined && photo.lng !== undefined) {
            locationInfo = `${formatLatLng(photo.lat, photo.lng)} (Server)`;
        } else if (
            window.photoTicketAssociationModule &&
            typeof window.photoTicketAssociationModule.getPhotoAssociatedTicketId === 'function' &&
            window.photoTicketAssociationModule.getPhotoAssociatedTicketId(photo) != null
        ) {
            locationInfo = 'Associated to ticket (no GPS)';
        }
        const uploadBit =
            photo.createdAt && typeof window.formatRecordedDateTime === 'function'
                ? ` - ${window.formatRecordedDateTime(photo.createdAt, '')}`
                : '';
        photoInfo.textContent = `Photo: ${locationInfo}${uploadBit}`;

        photoCard.appendChild(photoImgWrap);
        photoCard.appendChild(photoName);
        photoCard.appendChild(photoInfo);
        photosGrid.appendChild(photoCard);
    };

    const setActiveButtons = (mode) => {
        const active = 'var(--app-accent)';
        const inactive = 'var(--app-bg-surface)';
        const filterButtons = isPosrTicket ? [btnAll, btnNoGps] : [btnAll, btnRev, btnNoGps];
        filterButtons.forEach((btn) => {
            const key =
                btn === btnAll
                    ? 'map'
                    : btn === btnRev
                      ? 'revision'
                      : 'all';
            btn.style.background = mode === key ? active : inactive;
            btn.style.color = 'var(--app-text-inverse)';
        });
    };

    const fillGrid = (mode) => {
        const photos = getModalPhotos(mode);
        photosGrid.textContent = '';
        updateTitle(mode);
        if (photos.length === 0) {
            const noPhotos = document.createElement('div');
            noPhotos.textContent =
                mode === 'revision' && (ticket.photoRequirementCutoffPending || !ticket.photoRequirementCutoffIso)
                    ? 'No photos match this revision yet, or cutoff is not available from USAN.'
                    : 'No photos in this view.';
            noPhotos.style.cssText = 'color: var(--app-text-secondary); text-align: center; padding: 2rem; grid-column: 1 / -1;';
            photosGrid.appendChild(noPhotos);
        } else {
            photos.forEach((photo, galleryIndex) => appendOnePhoto(photo, galleryIndex, photos));
        }
        setActiveButtons(mode);
    };

    btnAll.onclick = () => {
        viewMode = 'map';
        activeTagName = '';
        tagSelect.value = '';
        fillGrid('map');
    };
    btnRev.onclick = () => {
        viewMode = 'revision';
        activeTagName = '';
        tagSelect.value = '';
        fillGrid('revision');
    };
    btnNoGps.onclick = () => {
        viewMode = 'all';
        activeTagName = '';
        tagSelect.value = '';
        fillGrid('all');
    };
    tagSelect.onchange = () => {
        const val = tagSelect.value;
        if (!val) {
            viewMode = 'map';
            activeTagName = '';
            fillGrid('map');
            return;
        }
        viewMode = 'tag';
        activeTagName = val;
        fillGrid('tag');
    };
    recentSelect.onchange = () => {
        const raw = Number(recentSelect.value);
        if (photoAssocMod && typeof photoAssocMod.normalizeTicketPhotoRecentDays === 'function') {
            modalRecentDays = photoAssocMod.normalizeTicketPhotoRecentDays(raw);
        } else {
            modalRecentDays = raw === recentDaysAll ? recentDaysAll : raw === 180 || raw === 365 ? raw : 90;
        }
        refreshTabCounts();
        fillGrid(viewMode);
    };
    toolbar.appendChild(btnAll);
    if (!isPosrTicket) {
        toolbar.appendChild(btnRev);
    }
    toolbar.appendChild(btnNoGps);
    toolbar.appendChild(tagSelect);
    toolbar.appendChild(recentSelect);

    header.appendChild(title);
    header.appendChild(closeButton);
    modalContent.appendChild(header);
    modalContent.appendChild(toolbar);
    modalContent.appendChild(photosGrid);
    modal.appendChild(modalContent);

    document.body.appendChild(modal);
    fillGrid('map');

    const escapeHandler = (e) => {
        if (e.key === 'Escape') {
            closeButton.click();
        }
    };
    document.addEventListener('keydown', escapeHandler);
    modal._ticketPhotosGalleryCleanup = function () {
        document.removeEventListener('keydown', escapeHandler);
    };
}

/** Remove ticket side photo gallery modals (e.g. before Match camera). */
function closeTicketPhotosSideGallery() {
    document.querySelectorAll('.ticket-photos-side-gallery').forEach((el) => {
        if (typeof el._ticketPhotosGalleryCleanup === 'function') {
            el._ticketPhotosGalleryCleanup();
            el._ticketPhotosGalleryCleanup = null;
        }
        el.remove();
    });
}

