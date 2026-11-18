/**
 * Shared read-only photo map markers (camera icon + optional MarkerCluster).
 * Callers supply media URLs via adapter — no auth imports.
 */
(function (global) {
    'use strict';

    const PHOTO_MAP_MARKER_ICON_SIZE = 18;
    const PHOTO_MIN_ZOOM_DEFAULT = 16;

    function cameraInnerHtml() {
        const icons = global.mapIcons;
        if (icons && typeof icons.camera === 'function') {
            return icons.camera(PHOTO_MAP_MARKER_ICON_SIZE);
        }
        return '📷';
    }

    function photoMarkerIconHtml(photo) {
        const noGps = !!(photo && photo.associatedNoGps);
        const badge = noGps
            ? '<span class="photo-marker-no-gps-badge" title="No GPS — placed at ticket area" aria-label="No GPS location">' +
              (global.mapIcons && typeof global.mapIcons.locationOff === 'function'
                  ? global.mapIcons.locationOff(10)
                  : '⊘') +
              '</span>'
            : '';
        return (
            '<div class="photo-marker-container">' +
            '<div class="photo-marker-icon">' +
            cameraInnerHtml() +
            '</div>' +
            badge +
            '</div>'
        );
    }

    function photoMarkerClassName(photo) {
        return 'photo-marker' + (photo && photo.associatedNoGps ? ' photo-marker--associated-nogps' : '');
    }

    function createPhotoClusterIcon(cluster) {
        const count = cluster.getChildCount();
        const display = count > 99 ? '99+' : String(count);
        return L.divIcon({
            html:
                '<div class="photo-cluster-marker-wrap">' +
                '<div class="photo-marker-icon">' +
                cameraInnerHtml() +
                '</div>' +
                '<span class="photo-cluster-count-badge" aria-label="' +
                count +
                ' photos">' +
                display +
                '</span>' +
                '</div>',
            className: 'photo-marker photo-cluster-marker',
            iconSize: [40, 32],
            iconAnchor: [16, 32],
            popupAnchor: [0, -28],
        });
    }

    /**
     * @param {object} [options] Leaflet MarkerClusterGroup options overrides
     * @returns {L.MarkerClusterGroup|L.LayerGroup}
     */
    function createPhotoMarkerClusterGroup(options) {
        if (typeof L.markerClusterGroup === 'function') {
            return L.markerClusterGroup(
                Object.assign(
                    {
                        maxClusterRadius: 22,
                        spiderfyOnMaxZoom: false,
                        showCoverageOnHover: false,
                        // Handled by bindPhotoClusterClick → list drawer (co-located / no-GPS).
                        zoomToBoundsOnClick: false,
                        iconCreateFunction: createPhotoClusterIcon,
                    },
                    options || {}
                )
            );
        }
        return L.layerGroup();
    }

    /**
     * Collect photo objects from cluster child markers.
     * @param {object} cluster Leaflet marker cluster layer
     * @returns {object[]}
     */
    function photosFromCluster(cluster) {
        if (!cluster || typeof cluster.getAllChildMarkers !== 'function') return [];
        const out = [];
        const seen = new Set();
        cluster.getAllChildMarkers().forEach((m) => {
            const photo = (m && m._sharePhoto) || (m && m.options && m.options.photo) || null;
            if (!photo) return;
            const key = photo.id != null ? String(photo.id) : '';
            if (key && seen.has(key)) return;
            if (key) seen.add(key);
            out.push(photo);
        });
        return out;
    }

    /**
     * Wire clusterclick: zoom toward cluster when useful, otherwise open photo list.
     * @param {object} group MarkerClusterGroup
     * @param {L.Map} map
     * @param {{
     *   onOpenPhotos: (photos: object[], meta: { lat: number, lng: number, count: number }) => void,
     *   drawerMinZoom?: number,
     * }} handlers
     */
    function bindPhotoClusterClick(group, map, handlers) {
        if (!group || typeof group.on !== 'function' || !map || !handlers) return;
        if (group._mapPhotoClusterClickBound) return;
        group._mapPhotoClusterClickBound = true;
        const drawerMinZoom =
            handlers.drawerMinZoom != null ? Number(handlers.drawerMinZoom) : map.getMaxZoom();

        let pending = null;
        const flushPending = () => {
            if (!pending) return;
            if (map.getZoom() >= pending.targetZoom) {
                const p = pending;
                pending = null;
                if (typeof handlers.onOpenPhotos === 'function') {
                    handlers.onOpenPhotos(p.photos, p.meta);
                }
                return;
            }
            map.setView([pending.meta.lat, pending.meta.lng], Math.min(pending.targetZoom, map.getZoom() + 2));
        };
        map.on('zoomend', flushPending);

        group.on('clusterclick', (e) => {
            if (!e || !e.layer) return;
            const cluster = e.layer;
            if (typeof L !== 'undefined' && L.DomEvent && typeof L.DomEvent.stopPropagation === 'function') {
                L.DomEvent.stopPropagation(e);
            }
            const childCount = cluster.getChildCount ? cluster.getChildCount() : 0;
            const markers = cluster.getAllChildMarkers ? cluster.getAllChildMarkers() : [];
            if (childCount <= 1) {
                if (markers[0] && typeof markers[0].fire === 'function') markers[0].fire('click');
                return;
            }
            const photos = photosFromCluster(cluster);
            const latlng = cluster.getLatLng && cluster.getLatLng();
            if (!latlng || !photos.length) return;
            const meta = {
                lat: latlng.lat,
                lng: latlng.lng,
                count: photos.length,
            };
            const targetZoom = Number.isFinite(drawerMinZoom) ? drawerMinZoom : map.getMaxZoom();
            if (map.getZoom() < targetZoom) {
                pending = { photos, meta, targetZoom };
                map.setView([meta.lat, meta.lng], Math.min(targetZoom, map.getZoom() + 2));
                return;
            }
            pending = null;
            if (typeof handlers.onOpenPhotos === 'function') {
                handlers.onOpenPhotos(photos, meta);
            }
        });
    }

    function escapeAttr(s) {
        if (s == null || s === '') return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * @param {object} photo { id, latitude, longitude, fileName?, associatedNoGps? }
     * @param {{
     *   thumbnailUrl?: (photo) => string,
     *   fileUrl?: (photo) => string,
     *   onOpen?: (photo, index, photos) => void,
     *   photos?: object[],
     *   index?: number,
     * }} [adapter]
     */
    function createPhotoMapMarker(photo, adapter) {
        const lat = Number(photo && photo.latitude);
        const lng = Number(photo && photo.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        const ad = adapter || {};
        const icon = L.divIcon({
            className: photoMarkerClassName(photo),
            html: photoMarkerIconHtml(photo),
            iconSize: [32, 32],
            iconAnchor: [16, 32],
            popupAnchor: [0, -32],
        });
        const marker = L.marker([lat, lng], {
            icon,
            riseOnHover: true,
            fileId: photo && photo.id != null ? photo.id : undefined,
            photo,
        });
        marker._sharePhoto = photo;
        const thumbUrl = typeof ad.thumbnailUrl === 'function' ? ad.thumbnailUrl(photo) : '';
        const fileUrl = typeof ad.fileUrl === 'function' ? ad.fileUrl(photo) : '';
        const imgSrc = thumbUrl || fileUrl;
        if (imgSrc) {
            const fallbackSrc = fileUrl && fileUrl !== imgSrc ? fileUrl : '';
            const popupHtml =
                `<button type="button" class="map-photo-popup-thumb" data-map-photo-open="1" title="View full size">` +
                `<img src="${escapeAttr(imgSrc)}" alt="" loading="lazy"` +
                (fallbackSrc ? ` data-fallback-src="${escapeAttr(fallbackSrc)}"` : '') +
                `>` +
                `</button>`;
            marker.bindPopup(popupHtml, { maxWidth: 200, className: 'map-photo-popup' });
            marker.on('popupopen', () => {
                const el = marker.getPopup() && marker.getPopup().getElement();
                const btn = el && el.querySelector('[data-map-photo-open]');
                if (!btn || btn.dataset.wired === '1') return;
                btn.dataset.wired = '1';
                const popupImg = btn.querySelector('img');
                if (popupImg) {
                    popupImg.addEventListener('error', function onPopupImgError() {
                        const next = popupImg.getAttribute('data-fallback-src');
                        popupImg.removeAttribute('data-fallback-src');
                        if (next && popupImg.getAttribute('src') !== next) {
                            popupImg.src = next;
                            return;
                        }
                        popupImg.removeEventListener('error', onPopupImgError);
                        popupImg.classList.add('server-photo-image-hidden');
                        popupImg.removeAttribute('src');
                    });
                }
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof ad.onOpen === 'function') {
                        ad.onOpen(photo, ad.index != null ? ad.index : 0, ad.photos || [photo]);
                    }
                });
            });
        }
        marker.on('click', () => {
            if (typeof ad.onOpen === 'function') {
                ad.onOpen(photo, ad.index != null ? ad.index : 0, ad.photos || [photo]);
            }
        });
        return marker;
    }

    /**
     * Replace cluster/group contents with markers for photos.
     * @returns {number} markers added
     */
    function setPhotoMarkersOnGroup(group, photos, adapter) {
        if (!group) return 0;
        if (typeof group.clearLayers === 'function') group.clearLayers();
        const list = Array.isArray(photos) ? photos : [];
        let n = 0;
        list.forEach((photo, index) => {
            const marker = createPhotoMapMarker(
                photo,
                Object.assign({}, adapter, { photos: list, index })
            );
            if (marker) {
                group.addLayer(marker);
                n += 1;
            }
        });
        return n;
    }

    global.mapPhotoMarkers = {
        PHOTO_MAP_MARKER_ICON_SIZE,
        PHOTO_MIN_ZOOM_DEFAULT,
        cameraInnerHtml,
        photoMarkerIconHtml,
        photoMarkerClassName,
        createPhotoClusterIcon,
        createPhotoMarkerClusterGroup,
        photosFromCluster,
        bindPhotoClusterClick,
        createPhotoMapMarker,
        setPhotoMarkersOnGroup,
    };
})(typeof window !== 'undefined' ? window : globalThis);
