/**
 * photos-media-urls.js — split from photos-core.js (Phase F5).
 * Access tokens, blob URL caches, thumbnail display.
 */
function getPhotoImageUrl(photo) {
    // Legacy: if photo has imageUrl (base64, blob preview, or backend URL), use it
    if (photo.imageUrl) {
        const url = String(photo.imageUrl);
        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('http')) {
            return url;
        }
        const baseUrl = (window.authModule && window.authModule.getApiBaseForMedia)
            ? window.authModule.getApiBaseForMedia()
            : (window.API_BASE_URL || window.location.origin);
        return `${baseUrl}${photo.imageUrl}`;
    }
    // If photo has a backend file ID, construct URL from backend
    if (photo.fileId) {
        const baseUrl = (window.authModule && window.authModule.getApiBaseForMedia)
            ? window.authModule.getApiBaseForMedia()
            : (window.API_BASE_URL || window.location.origin);
        return `${baseUrl}/api/data/media/${photo.fileId}/file`;
    }
    return null;
}

function getPhotoThumbnailDisplayUrl(photo) {
    if (!photo || photo.thumbnailUrl == null || String(photo.thumbnailUrl).trim() === '') {
        return null;
    }
    const thumb = String(photo.thumbnailUrl);
    if (thumb.startsWith('blob:') || thumb.startsWith('data:') || /^https?:\/\//i.test(thumb)) {
        return thumb;
    }
    const baseUrl = (window.authModule && window.authModule.getApiBaseForMedia)
        ? window.authModule.getApiBaseForMedia()
        : (window.API_BASE_URL || window.location.origin);
    return `${baseUrl}${thumb}`;
}

/** Full-size and thumbnail blobs: in-memory object URLs per org+file (~8h). Avoids repeat token + GET while valid. */
const PHOTO_BLOB_CACHE_TTL_MS = 8 * 60 * 60 * 1000;
/** After a failed thumbnail/full fetch, skip repeating token+GET for a few minutes (avoids storms on 404 + table re-renders). */
const PHOTO_FETCH_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const photoThumbnailObjectUrlCache = new Map();
const photoFullObjectUrlCache = new Map();
const photoThumbnailObjectUrlPending = new Map();
const photoFullObjectUrlPending = new Map();
let serverPhotoImageRequestSeq = 0;
/** @type {Map<string, number>} key -> Date.now() until which we skip network retry */
const photoFetchFailureUntil = new Map();

function photoFetchFailureKey(fileId, kind) {
    return photoThumbnailBlobCacheKey(fileId) + ':' + kind;
}

function isPhotoFetchFailureCooling(fileId, kind) {
    const until = photoFetchFailureUntil.get(photoFetchFailureKey(fileId, kind));
    return until != null && until > Date.now();
}

function markPhotoFetchFailure(fileId, kind) {
    photoFetchFailureUntil.set(photoFetchFailureKey(fileId, kind), Date.now() + PHOTO_FETCH_FAILURE_COOLDOWN_MS);
}

function prunePhotoFetchFailureMap() {
    const now = Date.now();
    /** @type {string[]} */
    const toDelete = [];
    photoFetchFailureUntil.forEach((until, k) => {
        if (until <= now) toDelete.push(k);
    });
    toDelete.forEach((k) => photoFetchFailureUntil.delete(k));
}

function prunePhotoObjectUrlCacheByMap(cacheMap) {
    const now = Date.now();
    /** @type {string[]} */
    const toDelete = [];
    cacheMap.forEach((v, k) => {
        if (!v || v.expiry <= now) {
            toDelete.push(k);
        }
    });
    toDelete.forEach((k) => {
        const v = cacheMap.get(k);
        if (v && v.blobUrl) {
            try {
                URL.revokeObjectURL(v.blobUrl);
            } catch (_) {}
        }
        cacheMap.delete(k);
    });
}

function prunePhotoBlobObjectUrlCaches() {
    prunePhotoObjectUrlCacheByMap(photoThumbnailObjectUrlCache);
    prunePhotoObjectUrlCacheByMap(photoFullObjectUrlCache);
    prunePhotoFetchFailureMap();
}

function photoThumbnailBlobCacheKey(fileId) {
    const oid = resolveCurrentOrgId();
    return `${oid != null ? String(oid) : 'na'}:${String(fileId)}`;
}

function clearPhotoThumbnailObjectUrlCache() {
    photoThumbnailObjectUrlCache.forEach((v) => {
        if (v && v.blobUrl) {
            try {
                URL.revokeObjectURL(v.blobUrl);
            } catch (_) {}
        }
    });
    photoThumbnailObjectUrlCache.clear();
    photoFullObjectUrlCache.forEach((v) => {
        if (v && v.blobUrl) {
            try {
                URL.revokeObjectURL(v.blobUrl);
            } catch (_) {}
        }
    });
    photoFullObjectUrlCache.clear();
    photoFetchFailureUntil.clear();
}

function evictPhotoBlobCachesForFile(fileId) {
    if (fileId == null) return;
    const key = photoThumbnailBlobCacheKey(fileId);
    const thumb = photoThumbnailObjectUrlCache.get(key);
    if (thumb && thumb.blobUrl) {
        try {
            URL.revokeObjectURL(thumb.blobUrl);
        } catch (_) {}
    }
    photoThumbnailObjectUrlCache.delete(key);
    const full = photoFullObjectUrlCache.get(key);
    if (full && full.blobUrl) {
        try {
            URL.revokeObjectURL(full.blobUrl);
        } catch (_) {}
    }
    photoFullObjectUrlCache.delete(key);
    photoThumbnailObjectUrlPending.delete(key);
    photoFullObjectUrlPending.delete(key);
    photoFetchFailureUntil.delete(photoFetchFailureKey(fileId, 'thumbnail'));
    photoFetchFailureUntil.delete(photoFetchFailureKey(fileId, 'full'));
}

async function fetchPhotoThumbnailBlob(fileId) {
    const baseUrl = (window.authModule && window.authModule.getApiBaseForMedia)
        ? window.authModule.getApiBaseForMedia()
        : (window.API_BASE_URL || window.location.origin);
    const token = await fetchMediaAccessToken(fileId);
    const url = `${baseUrl}/api/data/media/${fileId}/thumbnail?token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Thumbnail fetch failed');
    return res.blob();
}

async function fetchPhotoFileBlob(fileId) {
    const baseUrl = (window.authModule && window.authModule.getApiBaseForMedia)
        ? window.authModule.getApiBaseForMedia()
        : (window.API_BASE_URL || window.location.origin);
    const token = await fetchMediaAccessToken(fileId);
    const url = `${baseUrl}/api/data/media/${fileId}/file?token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Photo file fetch failed');
    return res.blob();
}

/** Full file via JWT + organization context (no short-lived token). */
async function fetchPhotoFileWithAuth(fileId) {
    const baseUrl = (window.authModule && window.authModule.getApiBaseForMedia)
        ? window.authModule.getApiBaseForMedia()
        : (window.API_BASE_URL || window.location.origin);
    const headers = (window.authModule && window.authModule.getAuthHeaders) ? window.authModule.getAuthHeaders() : {};
    if (!headers.Authorization) throw new Error('Not authenticated');
    const orgId = resolveCurrentOrgId();
    const orgQs =
        orgId != null && orgId !== ''
            ? `?organizationId=${encodeURIComponent(String(orgId))}`
            : '';
    const url = `${baseUrl}/api/data/media/${fileId}/file${orgQs}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error('Photo file fetch failed');
    return res.blob();
}

/** Resolve a photo record to a Blob for download/export (server file, data URL, or authenticated URL). */
async function blobFromPhotoForExport(photo) {
    if (!photo) throw new Error('Photo not found');
    if (photo.fileId != null && String(photo.fileId).trim() !== '') {
        const fileId = photo.fileId;
        const attempts = [
            () => fetchPhotoFileBlob(fileId),
            () => fetchPhotoFileWithAuth(fileId),
            () => fetchPhotoThumbnailBlob(fileId)
        ];
        let lastError = null;
        for (const attempt of attempts) {
            try {
                return await attempt();
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError || new Error('Photo file fetch failed');
    }
    if (photo.imageUrl && String(photo.imageUrl).startsWith('data:')) {
        const res = await fetch(photo.imageUrl);
        if (!res.ok) throw new Error('Photo data URL fetch failed');
        return res.blob();
    }
    const url = getPhotoImageUrl(photo);
    if (!url) throw new Error('No photo file available');
    const headers = (window.authModule && window.authModule.getAuthHeaders)
        ? window.authModule.getAuthHeaders()
        : {};
    const orgId = resolveCurrentOrgId();
    let fetchUrl = url;
    if (orgId != null && orgId !== '' && url.includes('/api/data/media/') && !url.includes('organizationId=')) {
        const joiner = url.includes('?') ? '&' : '?';
        fetchUrl = `${url}${joiner}organizationId=${encodeURIComponent(String(orgId))}`;
    }
    const res = await fetch(fetchUrl, Object.keys(headers).length ? { headers } : undefined);
    if (!res.ok) throw new Error('Photo file fetch failed');
    return res.blob();
}

/**
 * Resolved thumbnail as object URL; cached ~8h per org+file. Cache hit skips token + network fetch.
 */
async function getPhotoThumbnailObjectUrlCached(fileId) {
    if (fileId == null || String(fileId).trim() === '') return null;
    const offline = window.offlineModule && window.offlineModule.isOnline && !window.offlineModule.isOnline();
    if (offline && window.offlinePhotos && typeof window.offlinePhotos.getCachedPhotoObjectUrl === 'function') {
        const cached = await window.offlinePhotos.getCachedPhotoObjectUrl(fileId, 'thumb');
        if (cached) return cached;
    }
    prunePhotoBlobObjectUrlCaches();
    if (isPhotoFetchFailureCooling(fileId, 'thumb')) {
        throw new Error('photo-thumb-failed');
    }
    const key = photoThumbnailBlobCacheKey(fileId);
    const now = Date.now();
    const prev = photoThumbnailObjectUrlCache.get(key);
    if (prev && prev.expiry > now && prev.blobUrl) return prev.blobUrl;

    const pending = photoThumbnailObjectUrlPending.get(key);
    if (pending) return pending;

    const promise = fetchPhotoThumbnailBlob(fileId)
        .then(function (blob) {
            const blobUrl = URL.createObjectURL(blob);
            if (prev && prev.blobUrl) {
                try {
                    URL.revokeObjectURL(prev.blobUrl);
                } catch (_) {}
            }
            photoThumbnailObjectUrlCache.set(key, {
                blobUrl,
                blob,
                expiry: Date.now() + PHOTO_BLOB_CACHE_TTL_MS,
            });
            if (window.offlinePhotos && typeof window.offlinePhotos.cachePhotoBlob === 'function') {
                void window.offlinePhotos.cachePhotoBlob(fileId, blob, 'thumb');
            }
            return blobUrl;
        })
        .catch(function (err) {
            markPhotoFetchFailure(fileId, 'thumb');
            throw err;
        })
        .finally(function () {
            photoThumbnailObjectUrlPending.delete(key);
        });
    photoThumbnailObjectUrlPending.set(key, promise);
    return promise;
}

/**
 * Full original file as object URL; same ~8h in-memory cache as thumbnails. Cache hit skips token + network fetch.
 */
async function getPhotoFullObjectUrlCached(fileId) {
    if (fileId == null || String(fileId).trim() === '') return null;
    prunePhotoBlobObjectUrlCaches();
    if (isPhotoFetchFailureCooling(fileId, 'full')) {
        return null;
    }
    const key = photoThumbnailBlobCacheKey(fileId);
    const now = Date.now();
    const prev = photoFullObjectUrlCache.get(key);
    if (prev && prev.expiry > now && prev.blobUrl) return prev.blobUrl;

    const pending = photoFullObjectUrlPending.get(key);
    if (pending) return pending;

    const promise = fetchPhotoFileBlob(fileId)
        .then(function (blob) {
            const blobUrl = URL.createObjectURL(blob);
            if (prev && prev.blobUrl) {
                try {
                    URL.revokeObjectURL(prev.blobUrl);
                } catch (_) {}
            }
            photoFullObjectUrlCache.set(key, {
                blobUrl,
                blob,
                expiry: Date.now() + PHOTO_BLOB_CACHE_TTL_MS,
            });
            return blobUrl;
        })
        .catch(function (err) {
            markPhotoFetchFailure(fileId, 'full');
            throw err;
        })
        .finally(function () {
            photoFullObjectUrlPending.delete(key);
        });
    photoFullObjectUrlPending.set(key, promise);
    return promise;
}

/** Full original file blob; shares cache with object-URL helper (avoids fetch(blob:) CSP issues). */
async function getPhotoFullBlobCached(fileId) {
    if (fileId == null || String(fileId).trim() === '') return null;
    prunePhotoBlobObjectUrlCaches();
    if (isPhotoFetchFailureCooling(fileId, 'full')) return null;
    const key = photoThumbnailBlobCacheKey(fileId);
    const now = Date.now();
    const prev = photoFullObjectUrlCache.get(key);
    if (prev && prev.expiry > now && prev.blob) return prev.blob;
    await getPhotoFullObjectUrlCached(fileId);
    const entry = photoFullObjectUrlCache.get(key);
    return entry && entry.blob ? entry.blob : null;
}

/** Thumbnail blob; shares cache with object-URL helper. */
async function getPhotoThumbnailBlobCached(fileId) {
    if (fileId == null || String(fileId).trim() === '') return null;
    const offline = window.offlineModule && window.offlineModule.isOnline && !window.offlineModule.isOnline();
    if (offline && window.offlinePhotos && typeof window.offlinePhotos.getCachedPhotoBlob === 'function') {
        const cached = await window.offlinePhotos.getCachedPhotoBlob(fileId, 'thumb');
        if (cached) return cached;
    }
    prunePhotoBlobObjectUrlCaches();
    if (isPhotoFetchFailureCooling(fileId, 'thumb')) return null;
    const key = photoThumbnailBlobCacheKey(fileId);
    const now = Date.now();
    const prev = photoThumbnailObjectUrlCache.get(key);
    if (prev && prev.expiry > now && prev.blob) return prev.blob;
    await getPhotoThumbnailObjectUrlCached(fileId);
    const entry = photoThumbnailObjectUrlCache.get(key);
    return entry && entry.blob ? entry.blob : null;
}

/**
 * Ticket popup preview: loading spinner / fallback / image. Caller sets wrap._ticketPopupPreviewPhotoRef for click-to-view.
 * opts.ticketKey — dismiss stale async results when switching tickets.
 */
function hydrateTicketPopupThumbnailElement(wrap, previewPhoto, opts) {
    if (!wrap) return;
    const ticketKey = opts && opts.ticketKey != null ? String(opts.ticketKey) : '';
    wrap.setAttribute('data-thumb-for', ticketKey);

    const loading = wrap.querySelector('.ticket-popup-photo-thumb-loading');
    const img = wrap.querySelector('.ticket-popup-photo-thumb-img');
    const fallback = wrap.querySelector('.ticket-popup-photo-thumb-fallback');
    if (!img) return;

    const isStale = function () {
        return wrap.getAttribute('data-thumb-for') !== ticketKey;
    };

    const openPreviewPhoto = function (e) {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        const ph = wrap._ticketPopupPreviewPhotoRef;
        if (ph && typeof window.openPhotoViewer === 'function') {
            window.openPhotoViewer(ph, ph.fileName || 'Photo');
        }
    };

    const wirePreviewOpen = function (el) {
        if (!el) return;
        const ph = wrap._ticketPopupPreviewPhotoRef;
        if (ph && typeof window.openPhotoViewer === 'function') {
            el.style.cursor = 'pointer';
            el.onclick = openPreviewPhoto;
            el.title = 'Open photo';
        } else {
            el.onclick = null;
            el.style.cursor = '';
            el.removeAttribute('title');
        }
    };

    const showFallback = function () {
        if (isStale()) return;
        if (loading) {
            loading.hidden = true;
        }
        img.removeAttribute('src');
        img.style.display = 'none';
        img.onclick = null;
        img.style.cursor = '';
        if (fallback) {
            fallback.hidden = false;
            wirePreviewOpen(fallback);
        }
        wrap.removeAttribute('aria-busy');
    };

    const showImage = function (src) {
        if (isStale()) return;
        if (loading) {
            loading.hidden = true;
        }
        if (src && img.getAttribute('src') !== src) {
            img.src = src;
        }
        img.style.display = 'block';
        if (fallback) {
            fallback.hidden = true;
        }
        wrap.removeAttribute('aria-busy');
        wirePreviewOpen(img);
    };

    if (!wrap._ticketThumbEventShield) {
        wrap._ticketThumbEventShield = true;
        const stopBubble = function (ev) {
            ev.stopPropagation();
        };
        wrap.addEventListener('click', stopBubble, false);
        wrap.addEventListener('touchend', stopBubble, { passive: true });
    }

    wrap.setAttribute('aria-busy', 'true');
    if (fallback) {
        fallback.hidden = true;
    }
    img.style.display = 'none';
    img.removeAttribute('src');
    img.onclick = null;
    img.style.cursor = '';
    img.removeAttribute('title');
    if (fallback) {
        fallback.onclick = null;
        fallback.style.cursor = '';
        fallback.removeAttribute('title');
    }

    if (!previewPhoto) {
        if (loading) {
            loading.hidden = true;
        }
        showFallback();
        return;
    }

    if (loading) {
        loading.hidden = false;
    }

    if (previewPhoto.fileId && window.authModule && window.authModule.isAuthenticated && window.authModule.isAuthenticated()) {
        const renderBlobUrl = function (blobUrl) {
            if (isStale()) return;
            if (!blobUrl) {
                showFallback();
                return;
            }
            img.onload = function () {
                if (isStale()) return;
                showImage(blobUrl);
            };
            img.onerror = function () {
                showFallback();
            };
            img.src = blobUrl;
        };
        const loadFullPreview = function () {
            return getPhotoFullObjectUrlCached(previewPhoto.fileId).then(renderBlobUrl);
        };
        const hasKnownThumbnail =
            previewPhoto.thumbnailUrl != null && String(previewPhoto.thumbnailUrl).trim() !== '';
        const previewLoad = hasKnownThumbnail
            ? getPhotoThumbnailObjectUrlCached(previewPhoto.fileId).then(renderBlobUrl).catch(loadFullPreview)
            : loadFullPreview();
        previewLoad.catch(function () {
            showFallback();
        });
        return;
    }

    if (previewPhoto.thumbnailUrl && /^https?:\/\//i.test(String(previewPhoto.thumbnailUrl))) {
        img.onload = function () {
            if (isStale()) return;
            showImage(String(previewPhoto.thumbnailUrl));
        };
        img.onerror = function () {
            showFallback();
        };
        img.src = String(previewPhoto.thumbnailUrl);
        return;
    }

    const direct = getPhotoImageUrl(previewPhoto);
    if (direct) {
        img.onload = function () {
            if (isStale()) return;
            showImage(direct);
        };
        img.onerror = function () {
            showFallback();
        };
        img.src = direct;
        return;
    }

    showFallback();
}

// Fetch a short-lived access token for loading a media file in <img> (no Auth header possible)
function fetchMediaAccessToken(fileId) {
    const baseUrl = (window.authModule && window.authModule.getApiBaseForMedia)
        ? window.authModule.getApiBaseForMedia()
        : (window.API_BASE_URL || window.location.origin);
    const headers = (window.authModule && window.authModule.getAuthHeaders) ? window.authModule.getAuthHeaders() : {};
    if (!headers.Authorization) return Promise.reject(new Error('Not authenticated'));
    const orgId = resolveCurrentOrgId();
    const orgQs =
        orgId != null && orgId !== ''
            ? `?organizationId=${encodeURIComponent(String(orgId))}`
            : '';
    return fetch(`${baseUrl}/api/data/media/${fileId}/access-token${orgQs}`, { headers })
        .then(r => (r.ok ? r.json() : Promise.reject(new Error('Failed to get token'))))
        .then(data => data.token);
}

// Resolve photo to a URL that works in <img> (blob: URL from cache when possible; avoids token roundtrip on hit)
function getPhotoImageUrlWithToken(photo) {
    const url = getPhotoImageUrl(photo);
    if (!url) return Promise.resolve(null);
    if (photo.fileId && url.includes('/api/data/media/')) {
        return getPhotoFullObjectUrlCached(photo.fileId);
    }
    return Promise.resolve(url);
}

/** Fullscreen viewer: try token blob, JWT file, then thumbnail before giving up. */
async function getPhotoImageUrlForViewer(photo) {
    if (!photo) return null;
    const fileId = photo.fileId != null ? photo.fileId : null;
    if (fileId == null || String(fileId).trim() === '') {
        const url = getPhotoImageUrl(photo);
        return url || null;
    }
    const attempts = [
        () => getPhotoFullObjectUrlCached(fileId),
        async () => {
            const blob = await fetchPhotoFileWithAuth(fileId);
            return URL.createObjectURL(blob);
        },
        () => getPhotoThumbnailObjectUrlCached(fileId),
        async () => {
            const blob = await fetchPhotoThumbnailBlob(fileId);
            return URL.createObjectURL(blob);
        },
    ];
    for (const attempt of attempts) {
        try {
            const url = await attempt();
            if (url) return url;
        } catch (_) {
            /* try next source */
        }
    }
    return null;
}

const TRANSPARENT_PIXEL =
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function installBrokenMapImageGuard() {
    if (typeof document === 'undefined' || document.documentElement.dataset.aywBrokenImgGuard === '1') return;
    document.documentElement.dataset.aywBrokenImgGuard = '1';
    document.addEventListener(
        'error',
        function (ev) {
            const el = ev.target;
            if (!el || el.tagName !== 'IMG') return;
            if (el.dataset.aywBrokenHandled === '1') return;
            el.dataset.aywBrokenHandled = '1';
            if (el.classList.contains('leaflet-tile')) {
                el.src = TRANSPARENT_PIXEL;
                return;
            }
            el.classList.add('server-photo-image-hidden');
            el.removeAttribute('src');
            el.alt = '';
        },
        true
    );
}
installBrokenMapImageGuard();

function mountHiddenFileIdImage(host) {
    if (!host || host.querySelector('img[data-file-id]')) return null;
    const img = document.createElement('img');
    img.className = 'photo-popup-image server-photo-image-hidden';
    img.setAttribute('data-file-id', host.getAttribute('data-file-id'));
    const photoId = host.getAttribute('data-photo-id');
    if (photoId) img.setAttribute('data-photo-id', photoId);
    if (host.getAttribute('data-use-thumbnail') === '1') img.setAttribute('data-use-thumbnail', '1');
    img.alt = 'Photo';
    img.style.cursor = 'pointer';
    host.appendChild(img);
    return img;
}

function collectServerPhotoImages(root) {
    const list = [];
    if (!root) return list;
    if (root.matches && root.matches('img[data-file-id]')) list.push(root);
    if (root.querySelectorAll) {
        root.querySelectorAll('img[data-file-id]').forEach(function (img) {
            list.push(img);
        });
    }
    if (root.matches && root.matches('.photo-popup-image-container[data-file-id]')) {
        const created = mountHiddenFileIdImage(root);
        if (created) list.push(created);
    }
    if (root.querySelectorAll) {
        root.querySelectorAll('.photo-popup-image-container[data-file-id]').forEach(function (host) {
            const created = mountHiddenFileIdImage(host);
            if (created) list.push(created);
        });
    }
    return list;
}

// Set src on all img[data-file-id] in container (or document) using cached blobs when possible
function setServerPhotoImageSources(container) {
    const root = container && container.querySelector ? container : document;
    const imgs = collectServerPhotoImages(root);
    const tableViewport =
        root.closest && root.closest('.data-table-container')
            ? root.closest('.data-table-container')
            : null;
    const lazyInManageData =
        !!tableViewport &&
        window.IntersectionObserver &&
        root.id === 'dataTableBody';
    let observer = null;
    if (lazyInManageData) {
        observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                observer.unobserve(entry.target);
                loadServerPhotoImage(entry.target);
            });
        }, {
            root: tableViewport,
            // Roughly the visible rows plus the next few rows, without loading the whole page at once.
            rootMargin: '450px 0px',
            threshold: 0.01
        });
    }
    function serverPhotoImageFallbackMarkup() {
        const icons = window.mapIcons;
        if (icons && typeof icons.camera === 'function') {
            return icons.camera(20);
        }
        return '📷';
    }
    function ensureServerPhotoImageStatus(img) {
        let host = img && img.parentElement;
        if (!host) return null;
        const canUseExistingHost =
            host.classList.contains('data-table-thumb') ||
            host.classList.contains('photo-popup-image-container') ||
            host.classList.contains('server-photo-image-wrap') ||
            host.classList.contains('ticket-photos-gallery-img-wrap') ||
            host.classList.contains('photo-cluster-drawer__img-wrap');
        if (!canUseExistingHost) {
            const wrap = document.createElement('span');
            wrap.className = 'server-photo-image-wrap';
            host.insertBefore(wrap, img);
            wrap.appendChild(img);
            host = wrap;
        }
        host.classList.add('server-photo-image-status-host');
        let status = null;
        for (let i = 0; i < host.children.length; i += 1) {
            if (host.children[i].classList && host.children[i].classList.contains('server-photo-image-status')) {
                status = host.children[i];
                break;
            }
        }
        if (!status) {
            status = document.createElement('span');
            status.className = 'server-photo-image-status';
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            status.innerHTML = '<span class="server-photo-image-spinner" aria-hidden="true"></span><span class="server-photo-image-fallback" aria-hidden="true" hidden>' + serverPhotoImageFallbackMarkup() + '</span><span class="server-photo-image-status-text">Loading photo</span>';
            host.appendChild(status);
        }
        return status;
    }
    function setServerPhotoImageState(img, state) {
        const status = ensureServerPhotoImageStatus(img);
        if (!status) return;
        const host = img.parentElement;
        const spinner = status.querySelector('.server-photo-image-spinner');
        const fallback = status.querySelector('.server-photo-image-fallback');
        const text = status.querySelector('.server-photo-image-status-text');
        if (state === 'loading') {
            img.classList.add('server-photo-image-hidden');
            status.hidden = false;
            if (spinner) spinner.hidden = false;
            if (fallback) fallback.hidden = true;
            if (text) text.textContent = 'Loading photo';
            if (host) host.setAttribute('aria-busy', 'true');
            return;
        }
        if (state === 'loaded') {
            img.classList.remove('server-photo-image-hidden');
            status.hidden = true;
            if (host) host.removeAttribute('aria-busy');
            return;
        }
        img.classList.add('server-photo-image-hidden');
        img.removeAttribute('src');
        img.alt = '';
        status.hidden = false;
        if (spinner) spinner.hidden = true;
        if (fallback) fallback.hidden = false;
        if (text) text.textContent = 'Photo thumbnail unavailable';
        if (host) host.removeAttribute('aria-busy');
    }
    function loadServerPhotoImage(img) {
        if (!img || img.dataset.photoSrcLoading === '1' || img.dataset.photoSrcLoaded === '1') return;
        img.dataset.photoSrcLoading = '1';
        const fileId = img.getAttribute('data-file-id');
        if (!fileId) {
            delete img.dataset.photoSrcLoading;
            if (!img.getAttribute('src')) {
                setServerPhotoImageState(img, 'unavailable');
            }
            return;
        }
        const requestId = String(++serverPhotoImageRequestSeq);
        img.dataset.photoSrcRequestId = requestId;
        setServerPhotoImageState(img, 'loading');
        const useThumb = img.getAttribute('data-use-thumbnail') === '1';
        const chain = useThumb
            ? getPhotoThumbnailObjectUrlCached(fileId).catch(function () {
                return getPhotoFullObjectUrlCached(fileId);
            })
            : getPhotoFullObjectUrlCached(fileId);
        chain
            .then(function (blobUrl) {
                if (img.dataset.photoSrcRequestId !== requestId) return;
                if (!blobUrl) {
                    img.dataset.photoSrcLoaded = '1';
                    setServerPhotoImageState(img, 'unavailable');
                    return;
                }
                const finishLoaded = function () {
                    if (img.dataset.photoSrcRequestId !== requestId) return;
                    img.dataset.photoSrcLoaded = '1';
                    setServerPhotoImageState(img, 'loaded');
                };
                img.onerror = function () {
                    if (img.dataset.photoSrcRequestId !== requestId) return;
                    img.dataset.photoSrcLoaded = '1';
                    setServerPhotoImageState(img, 'unavailable');
                };
                img.onload = finishLoaded;
                img.src = blobUrl;
                if (img.complete && img.naturalWidth > 0) {
                    finishLoaded();
                } else if (typeof img.decode === 'function') {
                    img.decode().then(finishLoaded).catch(function () {
                        // onerror handles failed image loads; decode can reject during a source swap.
                    });
                }
            })
            .catch(function () {
                if (img.dataset.photoSrcRequestId !== requestId) return;
                img.dataset.photoSrcLoaded = '1';
                setServerPhotoImageState(img, 'unavailable');
            })
            .finally(function () {
                if (img.dataset.photoSrcRequestId === requestId) {
                    delete img.dataset.photoSrcLoading;
                }
            });
    }
    imgs.forEach((img) => {
        const fileId = img.getAttribute('data-file-id');
        if (!fileId) return;
        ensureServerPhotoImageStatus(img);
        if (observer) {
            observer.observe(img);
        } else {
            loadServerPhotoImage(img);
        }
    });
}

