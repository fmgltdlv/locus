/**
 * Read-only photo cluster list drawer (public share / guest maps).
 * Reuses .photo-cluster-drawer styles from the main stylesheet.
 */
(function (global) {
    'use strict';

    let drawerEl = null;
    let backdropEl = null;
    /** @type {object[]} */
    let currentPhotos = [];
    let mediaAdapter = null;

    function ensureDrawer() {
        if (drawerEl) return drawerEl;
        backdropEl = document.createElement('div');
        backdropEl.className = 'photo-cluster-drawer-backdrop';
        backdropEl.hidden = true;
        backdropEl.addEventListener('click', close);

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
            '</div>';
        drawerEl.querySelector('.photo-cluster-drawer__close').addEventListener('click', close);
        document.body.appendChild(backdropEl);
        document.body.appendChild(drawerEl);
        return drawerEl;
    }

    function close() {
        if (drawerEl) {
            drawerEl.classList.remove('photo-cluster-drawer--open');
        }
        if (backdropEl) backdropEl.hidden = true;
        currentPhotos = [];
        mediaAdapter = null;
    }

    function openPhotoAt(index) {
        const viewer = global.photoViewerReadOnly;
        if (!viewer || typeof viewer.open !== 'function' || !mediaAdapter) return;
        const gallery = currentPhotos.map((p) => ({
            url: typeof mediaAdapter.fileUrl === 'function' ? mediaAdapter.fileUrl(p) : '',
            fileName: (p && (p.fileName || p.file_name)) || 'Photo',
        })).filter((g) => g.url);
        if (!gallery.length) return;
        const safeIndex = Math.max(0, Math.min(Number(index) || 0, gallery.length - 1));
        viewer.open(gallery[safeIndex], null, { gallery, galleryIndex: safeIndex });
    }

    function renderGrid() {
        const el = ensureDrawer();
        const grid = el.querySelector('.photo-cluster-drawer__grid');
        const title = el.querySelector('.photo-cluster-drawer__title');
        if (!grid) return;
        grid.innerHTML = '';
        if (title) {
            title.textContent =
                currentPhotos.length > 1
                    ? `${currentPhotos.length} photos in area`
                    : 'Photos in area';
        }
        currentPhotos.forEach((photo, index) => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'photo-cluster-drawer__card';
            card.setAttribute('role', 'listitem');

            const imgWrap = document.createElement('span');
            imgWrap.className = 'photo-cluster-drawer__img-wrap';
            const img = document.createElement('img');
            img.className = 'photo-cluster-drawer__img server-photo-image-hidden';
            img.alt = '';
            img.loading = 'lazy';
            const thumb =
                mediaAdapter && typeof mediaAdapter.thumbnailUrl === 'function'
                    ? mediaAdapter.thumbnailUrl(photo)
                    : '';
            const file =
                mediaAdapter && typeof mediaAdapter.fileUrl === 'function'
                    ? mediaAdapter.fileUrl(photo)
                    : '';
            if (thumb || file) {
                img.onload = function () {
                    img.classList.remove('server-photo-image-hidden');
                };
                img.onerror = function () {
                    if (file && img.getAttribute('src') !== file) {
                        img.src = file;
                        return;
                    }
                    img.classList.add('server-photo-image-hidden');
                    img.removeAttribute('src');
                };
                img.src = thumb || file;
            }
            imgWrap.appendChild(img);

            const name = document.createElement('span');
            name.className = 'photo-cluster-drawer__name';
            const labelFn =
                window.photoMapItemUtils && typeof window.photoMapItemUtils.formatClusterCardLabel === 'function'
                    ? window.photoMapItemUtils.formatClusterCardLabel
                    : null;
            name.textContent = labelFn ? labelFn(photo) : (photo && (photo.fileName || photo.file_name)) || 'Photo';

            card.appendChild(imgWrap);
            card.appendChild(name);
            card.addEventListener('click', () => openPhotoAt(index));
            grid.appendChild(card);
        });
    }

    /**
     * @param {object[]} photos
     * @param {{ thumbnailUrl?: Function, fileUrl?: Function, title?: string }} adapter
     */
    function open(photos, adapter) {
        currentPhotos = Array.isArray(photos) ? photos.filter(Boolean) : [];
        mediaAdapter = adapter || null;
        if (!currentPhotos.length) return;
        const el = ensureDrawer();
        renderGrid();
        if (adapter && adapter.title) {
            const title = el.querySelector('.photo-cluster-drawer__title');
            if (title) title.textContent = String(adapter.title);
        }
        backdropEl.hidden = false;
        el.classList.add('photo-cluster-drawer--open');
    }

    global.photoClusterListReadOnly = {
        open,
        close,
    };
})(typeof window !== 'undefined' ? window : globalThis);
