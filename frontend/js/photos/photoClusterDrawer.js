/**
 * Side panel for dense server-side photo clusters and client-cluster galleries at max zoom.
 */
(function () {
    let drawerEl = null;
    let backdropEl = null;
    let currentQuery = null;
    let currentPage = 1;
    /** @type {object[]} */
    let drawerGalleryItems = [];

    function ensureDrawer() {
        if (drawerEl) return drawerEl;
        backdropEl = document.createElement('div');
        backdropEl.className = 'photo-cluster-drawer-backdrop';
        backdropEl.hidden = true;
        backdropEl.addEventListener('click', closePhotoClusterDrawer);

        drawerEl = document.createElement('aside');
        drawerEl.className = 'photo-cluster-drawer';
        drawerEl.setAttribute('aria-label', 'Photo cluster');
        drawerEl.innerHTML =
            '<header class="photo-cluster-drawer__header">' +
            '<h2 class="photo-cluster-drawer__title">Photos in area</h2>' +
            '<button type="button" class="photo-cluster-drawer__close" aria-label="Close">&times;</button>' +
            '</header>' +
            '<div class="photo-cluster-drawer__body">' +
            '<div class="photo-cluster-drawer__grid" role="list"></div>' +
            '<div class="photo-cluster-drawer__footer">' +
            '<button type="button" class="photo-cluster-drawer__more">Load more</button>' +
            '</div></div>';
        drawerEl.querySelector('.photo-cluster-drawer__close').addEventListener('click', closePhotoClusterDrawer);
        drawerEl.querySelector('.photo-cluster-drawer__more').addEventListener('click', () => {
            currentPage += 1;
            void loadClusterPage();
        });
        document.body.appendChild(backdropEl);
        document.body.appendChild(drawerEl);
        return drawerEl;
    }

    function normalizeOpenArgs(arg1, arg2) {
        if (arg1 && typeof arg1 === 'object') {
            return {
                cellKey: arg1.cellKey || null,
                clusterKind: arg1.clusterKind || null,
                ticketBaseNumber: arg1.ticketBaseNumber || null,
                photoIds: Array.isArray(arg1.photoIds) ? arg1.photoIds : null,
                inlineItems: Array.isArray(arg1.inlineItems) ? arg1.inlineItems : null,
                title: arg1.title || null,
                count: arg1.count != null ? Number(arg1.count) : null,
            };
        }
        return {
            cellKey: arg1 != null ? String(arg1) : null,
            clusterKind: null,
            ticketBaseNumber: null,
            photoIds: null,
            inlineItems: null,
            title: null,
            count: arg2 != null ? Number(arg2) : null,
        };
    }

    function getOrgId() {
        return window.orgSelectorModule && window.orgSelectorModule.getCurrentOrgId
            ? window.orgSelectorModule.getCurrentOrgId()
            : null;
    }

    function getMapQueryBase() {
        const map = window.map;
        if (!map) return null;
        const mod = window.photoMapLoaderModule;
        const bounds =
            mod && typeof mod.getPhotoMapViewportBounds === 'function'
                ? mod.getPhotoMapViewportBounds(map)
                : map.getBounds();
        if (!bounds || !bounds.isValid()) return null;
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const zoom =
            mod && typeof mod.getPhotoMapQueryZoom === 'function'
                ? mod.getPhotoMapQueryZoom(map)
                : map.getZoom();
        const candidates =
            mod && typeof mod.getPhotoMapTicketCandidates === 'function'
                ? mod.getPhotoMapTicketCandidates()
                : [];
        const ticketIds = candidates.map((t) => t.id).join(',');
        return {
            bbox: [sw.lng, sw.lat, ne.lng, ne.lat].join(','),
            zoom,
            ticketIds,
        };
    }

    function getClusterDrawerFetchBase() {
        return window.authModule && window.authModule.API_BASE ? window.authModule.API_BASE : '/api';
    }

    function getClusterDrawerMediaBase() {
        return window.authModule && typeof window.authModule.getApiBaseForMedia === 'function'
            ? window.authModule.getApiBaseForMedia()
            : String(getClusterDrawerFetchBase()).replace(/\/api$/, '');
    }

    function resolveClusterThumbSrc(item, mediaBase) {
        const thumb = item && item.thumbnailUrl ? String(item.thumbnailUrl) : '';
        if (!thumb) return '';
        if (thumb.startsWith('http')) return thumb;
        const base = String(mediaBase || '').replace(/\/api$/, '');
        return base + thumb;
    }

    function showDrawerGridMessage(grid, message) {
        if (!grid) return;
        grid.innerHTML = '';
        const el = document.createElement('p');
        el.className = 'photo-cluster-drawer__empty';
        el.textContent = message;
        grid.appendChild(el);
    }

    function mapDrawerItemToViewerPhoto(item, apiBase) {
        if (window.photoMapItemUtils && typeof window.photoMapItemUtils.mapApiPhotoItemToViewerPhoto === 'function') {
            return window.photoMapItemUtils.mapApiPhotoItemToViewerPhoto(item, apiBase);
        }
        const base = apiBase.replace(/\/api$/, '');
        const thumb = item.thumbnailUrl
            ? item.thumbnailUrl.startsWith('http')
                ? item.thumbnailUrl
                : base + item.thumbnailUrl
            : null;
        const lat = Number(item.lat);
        const lng = Number(item.lng);
        const photo = {
            id: `map-photo-${item.id}`,
            fileId: item.id,
            fileName: item.fileName || 'Photo',
            thumbnailUrl: thumb,
            imageUrl: `${base}/api/data/media/${item.id}/file`,
            associatedNoGps: !!item.associatedNoGps,
            createdAt: item.createdAt,
            note: typeof item.note === 'string' ? item.note : '',
            tags: Array.isArray(item.tags) ? item.tags : [],
            noteLastEditedBy: typeof item.noteLastEditedBy === 'string' ? item.noteLastEditedBy : '',
            noteLastEditedAt: typeof item.noteLastEditedAt === 'string' ? item.noteLastEditedAt : '',
            hasWhitePaintMark: item.hasWhitePaintMark === true,
            uploadedBy: item.uploadedBy != null && item.uploadedBy !== '' ? String(item.uploadedBy) : '',
        };
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            photo.latlng = { lat: lat, lng: lng };
        }
        return photo;
    }

    function openDrawerItemInViewer(item, galleryIndex, apiBase) {
        const gallery = drawerGalleryItems.map((row) => mapDrawerItemToViewerPhoto(row, apiBase));
        const photo = gallery[galleryIndex];
        if (!photo) return;
        if (typeof window.openPhotoViewer === 'function') {
            window.openPhotoViewer(photo, photo.fileName, { gallery, galleryIndex });
            return;
        }
        if (window.photosModule && typeof window.photosModule.openPhotoFromMapItem === 'function') {
            window.photosModule.openPhotoFromMapItem(item, { gallery, galleryIndex });
        }
    }

    function appendDrawerCards(grid, items, mediaBase) {
        items.forEach((item) => {
            const galleryIndex = drawerGalleryItems.length;
            drawerGalleryItems.push(item);
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'photo-cluster-drawer__card';
            card.setAttribute('role', 'listitem');

            const imgWrap = document.createElement('span');
            imgWrap.className = 'photo-cluster-drawer__img-wrap';

            const img = document.createElement('img');
            img.className = 'photo-cluster-drawer__img server-photo-image-hidden';
            img.alt = '';

            const name = document.createElement('span');
            name.className = 'photo-cluster-drawer__name';
            const labelFn =
                window.photoMapItemUtils && typeof window.photoMapItemUtils.formatClusterCardLabel === 'function'
                    ? window.photoMapItemUtils.formatClusterCardLabel
                    : null;
            name.textContent = labelFn ? labelFn(item) : item.fileName || 'Photo';

            imgWrap.appendChild(img);
            card.appendChild(imgWrap);
            card.appendChild(name);

            const fileId = item.id != null ? String(item.id) : '';
            const directThumb = resolveClusterThumbSrc(item, mediaBase);
            if (directThumb) {
                img.loading = 'lazy';
                img.onload = function () {
                    img.classList.remove('server-photo-image-hidden');
                };
                img.onerror = function () {
                    img.classList.add('server-photo-image-hidden');
                    img.removeAttribute('src');
                    if (!fileId || !window.photosModule || typeof window.photosModule.setServerPhotoImageSources !== 'function') {
                        return;
                    }
                    img.onerror = null;
                    img.setAttribute('data-file-id', fileId);
                    img.setAttribute('data-use-thumbnail', '1');
                    window.photosModule.setServerPhotoImageSources(imgWrap);
                };
                img.src = directThumb;
            } else if (
                fileId &&
                window.photosModule &&
                typeof window.photosModule.setServerPhotoImageSources === 'function'
            ) {
                img.setAttribute('data-file-id', fileId);
                img.setAttribute('data-use-thumbnail', '1');
                window.photosModule.setServerPhotoImageSources(imgWrap);
            }

            card.addEventListener('click', () => {
                openDrawerItemInViewer(item, galleryIndex, mediaBase);
            });
            grid.appendChild(card);
        });
    }

    async function loadClusterPage() {
        const el = ensureDrawer();
        const grid = el.querySelector('.photo-cluster-drawer__grid');
        const moreBtn = el.querySelector('.photo-cluster-drawer__more');
        const query = currentQuery || {};
        const fetchBase = getClusterDrawerFetchBase();
        const mediaBase = getClusterDrawerMediaBase();

        if (query.inlineItems && query.inlineItems.length) {
            if (currentPage === 1) {
                grid.innerHTML = '';
                drawerGalleryItems = [];
            }
            appendDrawerCards(grid, query.inlineItems, mediaBase);
            moreBtn.hidden = true;
            moreBtn.disabled = false;
            return;
        }

        const orgId = getOrgId();
        const q = getMapQueryBase();
        if (!orgId || !q) {
            showDrawerGridMessage(grid, 'Could not load photos for this cluster. Try zooming the map and clicking again.');
            moreBtn.hidden = true;
            return;
        }

        const headers =
            window.authModule && typeof window.authModule.getAuthHeaders === 'function'
                ? window.authModule.getAuthHeaders()
                : {};
        moreBtn.disabled = true;

        try {
            const hasFilter =
                query.cellKey ||
                (query.clusterKind && query.ticketBaseNumber) ||
                (query.photoIds && query.photoIds.length);
            if (!hasFilter) {
                showDrawerGridMessage(grid, 'No photos found for this cluster.');
                return;
            }

            const params = new URLSearchParams({
                organizationId: String(orgId),
                bbox: q.bbox,
                zoom: String(q.zoom),
                ticketIds: q.ticketIds,
                page: String(currentPage),
                limit: '50',
            });
            if (query.cellKey) params.set('cellKey', query.cellKey);
            if (query.clusterKind) params.set('clusterKind', query.clusterKind);
            if (query.ticketBaseNumber) params.set('ticketBaseNumber', query.ticketBaseNumber);
            if (query.photoIds && query.photoIds.length) params.set('photoIds', query.photoIds.join(','));

            const res = await fetch(`${fetchBase}/data/media/photos/map/cluster?${params.toString()}`, { headers });
            if (!res.ok) throw new Error(String(res.status));
            const data = await res.json();
            const items = data.items || [];
            if (currentPage === 1) {
                grid.innerHTML = '';
                drawerGalleryItems = [];
            }
            appendDrawerCards(grid, items, mediaBase);
            moreBtn.hidden = !data.hasMore;
            if (!items.length && currentPage === 1) {
                showDrawerGridMessage(grid, 'No photos found in this cluster.');
            }
        } catch (e) {
            console.warn('[photoClusterDrawer] load failed:', e.message || e);
            if (currentPage === 1) {
                showDrawerGridMessage(grid, 'Could not load photos. Try again.');
            }
        } finally {
            moreBtn.disabled = false;
        }
    }

    function openPhotoClusterDrawer(arg1, arg2) {
        const query = normalizeOpenArgs(arg1, arg2);
        currentQuery = query;
        currentPage = 1;
        drawerGalleryItems = [];
        const el = ensureDrawer();
        const title = el.querySelector('.photo-cluster-drawer__title');
        if (title) {
            if (query.title) title.textContent = query.title;
            else if (query.count) title.textContent = `${query.count} photos in area`;
            else title.textContent = 'Photos in area';
        }
        el.classList.add('photo-cluster-drawer--open');
        backdropEl.hidden = false;
        void loadClusterPage();
    }

    function isPhotoClusterDrawerOpen() {
        return !!(drawerEl && drawerEl.classList.contains('photo-cluster-drawer--open'));
    }

    function closePhotoClusterDrawer() {
        if (drawerEl) drawerEl.classList.remove('photo-cluster-drawer--open');
        if (backdropEl) backdropEl.hidden = true;
        if (window.photosModule && typeof window.photosModule.resetPhotoMapClusterHighlight === 'function') {
            window.photosModule.resetPhotoMapClusterHighlight();
        }
        currentQuery = null;
        currentPage = 1;
        drawerGalleryItems = [];
    }

    window.photoClusterDrawerModule = {
        openPhotoClusterDrawer,
        closePhotoClusterDrawer,
        isPhotoClusterDrawerOpen,
    };
})();
