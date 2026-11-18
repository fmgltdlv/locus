/**
 * photos-layer.js — split from photos-core.js (Phase F5).
 * Clusters, layer init, org reload, offline reconcile.
 */
function defaultPhotosLayerVisibleOnLoad() {
    if (typeof window.getUserProfile !== 'function') return true;
    const p = window.getUserProfile();
    return p.defaultLayerPhotos !== false;
}

let serverPhotoClusterMarkers = [];
let noGpsTicketClusterMarkers = [];
let coincidentPhotoStackMarkers = [];
let lastServerClusterPayload = null;
let lastNoGpsClusterPayload = null;
let photoStackGroupingZoomBracket = null;
/** While drawing a ticket in "hide" mode, keep photo pins off the map without changing the user's layer checkbox. */
let photosHiddenForTicketDraw = false;
let photoMapClusterHighlightEl = null;
/** @type {{ lat: number, lng: number } | null} */
let photoMapClusterHighlightRef = null;

function computeCellKeyForLatLng(lat, lng, zoom) {
    const z = Number(zoom);
    if (!Number.isFinite(z) || z < PHOTO_MARKERS_MIN_ZOOM) return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    let cell = 0.00007;
    if (z <= 16) cell = 0.00035;
    else if (z <= 17) cell = 0.0002;
    else if (z <= 18) cell = 0.00012;
    return `${Math.floor(lng / cell)}:${Math.floor(lat / cell)}`;
}

function clearServerPhotoClusters() {
    const layer = getPhotosServerClusterLayer();
    serverPhotoClusterMarkers.forEach((marker) => {
        if (!marker) return;
        if (layer && typeof layer.removeLayer === 'function') {
            layer.removeLayer(marker);
        } else if (typeof marker.remove === 'function') {
            marker.remove();
        }
    });
    serverPhotoClusterMarkers = [];
}

function clearNoGpsTicketClusters() {
    const layer = getPhotosServerClusterLayer();
    noGpsTicketClusterMarkers.forEach((marker) => {
        if (!marker) return;
        if (layer && typeof layer.removeLayer === 'function') {
            layer.removeLayer(marker);
        } else if (typeof marker.remove === 'function') {
            marker.remove();
        }
    });
    noGpsTicketClusterMarkers = [];
}

function clearCoincidentPhotoStackMarkers() {
    const layer = getPhotosServerClusterLayer();
    coincidentPhotoStackMarkers.forEach((marker) => {
        if (!marker) return;
        if (layer && typeof layer.removeLayer === 'function') {
            layer.removeLayer(marker);
        } else if (typeof marker.remove === 'function') {
            marker.remove();
        }
    });
    coincidentPhotoStackMarkers = [];
}

function coincidentPhotoStackKey(lat, lng) {
    const eps = PHOTO_COINCIDENT_STACK_EPSILON;
    return `${Math.round(lat / eps)}:${Math.round(lng / eps)}`;
}

function partitionCoincidentPhotoStacks(photos) {
    const buckets = new Map();
    (photos || []).forEach((photo) => {
        if (!photo || !photo.latlng) return;
        const lat = Number(photo.latlng.lat);
        const lng = Number(photo.latlng.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        const key = coincidentPhotoStackKey(lat, lng);
        if (!buckets.has(key)) {
            buckets.set(key, { photos: [], latSum: 0, lngSum: 0 });
        }
        const bucket = buckets.get(key);
        bucket.photos.push(photo);
        bucket.latSum += lat;
        bucket.lngSum += lng;
    });
    const singles = [];
    const stacks = [];
    buckets.forEach((bucket) => {
        const count = bucket.photos.length;
        if (count >= 2) {
            stacks.push({
                photos: bucket.photos,
                lat: bucket.latSum / count,
                lng: bucket.lngSum / count,
            });
        } else if (count === 1) {
            singles.push(bucket.photos[0]);
        }
    });
    return { singles, stacks };
}

function collectPhotoIdsFromStack(stack) {
    const photoIds = [];
    (stack.photos || []).forEach((photo) => {
        const fid = photo && photo.fileId != null ? Number(photo.fileId) : NaN;
        if (Number.isFinite(fid)) photoIds.push(fid);
    });
    return photoIds;
}

function openPhotoStackInClusterDrawer(map, lat, lng, stack, sourceMarker) {
    const photos = stack.photos || [];
    const count = photos.length;
    const stackLatLng = { lat: Number(lat), lng: Number(lng) };
    const utils = window.photoMapItemUtils;
    const inlineItems =
        utils && typeof utils.clusterInlineItemFromMapPhoto === 'function'
            ? photos
                  .map((photo) => utils.clusterInlineItemFromMapPhoto(photo, stackLatLng))
                  .filter(Boolean)
            : [];
    const photoIds = collectPhotoIdsFromStack(stack);
    const drawerOptions = {
        count,
        title: count ? `${count} photos in area` : 'Photos in area',
        sourceMarker: sourceMarker || null,
    };
    if (inlineItems.length >= 2) {
        drawerOptions.inlineItems = inlineItems;
    } else if (photoIds.length >= 2) {
        drawerOptions.photoIds = photoIds;
    } else {
        const cellKey = computeCellKeyForLatLng(lat, lng, map.getZoom());
        if (cellKey) drawerOptions.cellKey = cellKey;
    }
    scheduleOrOpenClusterDrawer(map, lat, lng, drawerOptions);
}

function renderCoincidentPhotoStackMarkers(stacks) {
    const map = window.map;
    if (!map || !stacks || !stacks.length) return;
    if (!photosLayerGroup) initPhotosLayer();
    stacks.forEach((stack) => {
        const lat = Number(stack.lat);
        const lng = Number(stack.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        const count = (stack.photos || []).length;
        if (count < 2) return;
        const icon = createPhotoClusterIcon({ getChildCount: () => count });
        const marker = L.marker([lat, lng], { icon });
        marker.on('click', function () {
            if (forwardMapClickDuringTicketDraw(marker.getLatLng())) return;
            openPhotoStackInClusterDrawer(map, lat, lng, stack, marker);
        });
        const serverLayer = getPhotosServerClusterLayer();
        if (serverLayer) {
            marker.addTo(serverLayer);
        } else {
            marker.addTo(map);
        }
        coincidentPhotoStackMarkers.push(marker);
    });
}

function wirePhotoMapMarkerPopup(marker, photo) {
    if (!marker || !photo) return marker;
    marker.bindPopup(buildPhotoMapPopupHtml(photo), { autoPan: false });
    marker.on('popupopen', function () {
        const el = this.getPopup().getElement();
        if (el) setServerPhotoImageSources(el);
        bindPhotoPopupNoteButton(el);
        centerMapOnPhotoPopup(this);
    });
    wirePhotoMapMarkerLeafletMobile(marker);
    return marker;
}

function createPhotoMarkerWithPopup(photo, lat, lng, options) {
    if (!photo) return null;
    const latNum = Number(lat);
    const lngNum = Number(lng);
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;

    const marker = L.marker([latNum, lngNum], {
        icon: L.divIcon({
            className: getPhotoMapMarkerClassName(photo),
            html: getPhotoMapMarkerIconHtml(photo),
            iconSize: [32, 32],
            iconAnchor: [16, 32],
            popupAnchor: [0, -32],
        }),
        photoId: photo.id,
        fileId: photo.fileId != null ? photo.fileId : null,
    });

    wirePhotoMapMarkerPopup(marker, photo);
    marker.on('click', function () {
        if (!forwardMapClickDuringTicketDraw(marker.getLatLng())) return;
        if (typeof marker.closePopup === 'function') marker.closePopup();
    });

    const layerGroup = options && options.layerGroup;
    const map = options && options.map;
    if (layerGroup) {
        marker.addTo(layerGroup);
    } else if (map) {
        marker.addTo(map);
    }

    if (!options || options.setPhotoMarkerRef !== false) {
        photo.marker = marker;
    }
    return marker;
}

function createNoGpsTicketClusterMarker(lat, lng, count, drawerOptions, targetLayer) {
    const map = window.map;
    const latNum = Number(lat);
    const lngNum = Number(lng);
    const photoCount = Number(count) || 0;
    if (!map || !Number.isFinite(latNum) || !Number.isFinite(lngNum) || photoCount < 1) return null;

    const marker = L.marker([latNum, lngNum], { icon: createNoGpsTicketClusterIcon(photoCount) });
    marker.on('click', function () {
        if (forwardMapClickDuringTicketDraw(marker.getLatLng())) return;
        const opts = Object.assign({}, drawerOptions || {}, {
            count: photoCount,
            title:
                photoCount === 1
                    ? '1 photo without location'
                    : `${photoCount} photos without location`,
            sourceMarker: marker,
        });
        openClusterDrawerAtMaxZoom(map, latNum, lngNum, opts);
    });
    if (targetLayer) marker.addTo(targetLayer);
    else marker.addTo(map);
    return marker;
}

function addPhotoPointMarkerToMap(photo, map) {
    if (!photo || !photo.latlng || !map) return null;
    if (!photoPassesRecentWindow(photo)) return null;
    if (!photoPassesTimeWarp(photo)) return null;
    const lat = Number(photo.latlng.lat);
    const lng = Number(photo.latlng.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const pointLayer = getPhotosPointMarkerLayer();
    const marker = createPhotoMarkerWithPopup(photo, lat, lng, {
        layerGroup: pointLayer || undefined,
        map: pointLayer ? undefined : map,
    });
    return marker;
}

function filterPhotosEligibleForMapMarkers(photos) {
    return (photos || []).filter(
        (photo) =>
            photo &&
            photo.latlng &&
            (photo.imageUrl || photo.fileId || photo.offlinePendingUpload)
    );
}

function updatePhotoStackGroupingBracket(map) {
    if (!map || typeof map.getZoom !== 'function') {
        photoStackGroupingZoomBracket = null;
        return;
    }
    photoStackGroupingZoomBracket =
        map.getZoom() >= PHOTO_CLUSTER_DRAWER_ZOOM ? 'drawer' : 'cluster';
}

function createServerClusterIcon(count, hasThumb) {
    const display = count > 99 ? '99+' : String(count);
    const thumbClass = hasThumb ? ' photo-server-cluster--has-thumb' : '';
    return L.divIcon({
        html:
            '<div class="photo-server-cluster-marker' +
            thumbClass +
            '">' +
            '<div class="photo-marker-icon">' +
            getPhotoMapMarkerIconInnerHtml() +
            '</div>' +
            '<span class="photo-cluster-count-badge photo-server-cluster-badge">' +
            display +
            '</span></div>',
        className: 'photo-marker photo-server-cluster-marker',
        iconSize: [44, 36],
        iconAnchor: [18, 36],
        popupAnchor: [0, -30],
    });
}

function createNoGpsTicketClusterIcon(count) {
    const display = count > 99 ? '99+' : String(count);
    const locationOff =
        window.mapIcons && typeof window.mapIcons.locationOff === 'function'
            ? window.mapIcons.locationOff(10)
            : '⊘';
    return L.divIcon({
        html:
            '<div class="photo-nogps-ticket-cluster-marker">' +
            '<div class="photo-marker-icon">' +
            getPhotoMapMarkerIconInnerHtml() +
            '</div>' +
            '<span class="photo-marker-no-gps-badge" aria-hidden="true">' +
            locationOff +
            '</span>' +
            '<span class="photo-cluster-count-badge photo-nogps-ticket-cluster-badge">' +
            display +
            '</span></div>',
        className: 'photo-marker photo-nogps-ticket-cluster',
        iconSize: [44, 36],
        iconAnchor: [18, 36],
        popupAnchor: [0, -30],
    });
}

function clearPhotoMapClusterHighlight() {
    if (photoMapClusterHighlightEl) {
        photoMapClusterHighlightEl.classList.remove('photo-cluster-marker--highlighted');
        photoMapClusterHighlightEl = null;
    }
}

function resetPhotoMapClusterHighlight() {
    clearPhotoMapClusterHighlight();
    photoMapClusterHighlightRef = null;
}

function rememberPhotoMapClusterHighlightRef(lat, lng, sourceMarker) {
    if (sourceMarker && typeof sourceMarker.getLatLng === 'function') {
        const ll = sourceMarker.getLatLng();
        if (ll) {
            photoMapClusterHighlightRef = { lat: ll.lat, lng: ll.lng };
            return;
        }
    }
    const targetLat = Number(lat);
    const targetLng = Number(lng);
    if (Number.isFinite(targetLat) && Number.isFinite(targetLng)) {
        photoMapClusterHighlightRef = { lat: targetLat, lng: targetLng };
    }
}

function restorePhotoMapClusterHighlightIfDrawerOpen() {
    if (!photoMapClusterHighlightRef) return;
    const mod = window.photoClusterDrawerModule;
    if (!mod || typeof mod.isPhotoClusterDrawerOpen !== 'function' || !mod.isPhotoClusterDrawerOpen()) return;
    highlightPhotoMapClusterAt(photoMapClusterHighlightRef.lat, photoMapClusterHighlightRef.lng);
}

function highlightPhotoMapClusterFromTarget(target) {
    clearPhotoMapClusterHighlight();
    if (!target) return;
    let el = target._icon || null;
    if (!el && typeof target.getElement === 'function') {
        el = target.getElement();
    }
    if (el) {
        el.classList.add('photo-cluster-marker--highlighted');
        photoMapClusterHighlightEl = el;
    }
}

function highlightPhotoMapClusterAt(lat, lng) {
    const targetLat = Number(lat);
    const targetLng = Number(lng);
    if (!Number.isFinite(targetLat) || !Number.isFinite(targetLng)) return;
    const epsilon = 0.00003;
    const matches = (marker) => {
        if (!marker || typeof marker.getLatLng !== 'function') return false;
        const ll = marker.getLatLng();
        if (!ll) return false;
        return Math.abs(ll.lat - targetLat) < epsilon && Math.abs(ll.lng - targetLng) < epsilon;
    };
    const markerLists = [
        serverPhotoClusterMarkers,
        noGpsTicketClusterMarkers,
        coincidentPhotoStackMarkers,
    ];
    for (let i = 0; i < markerLists.length; i += 1) {
        const list = markerLists[i];
        for (let j = 0; j < list.length; j += 1) {
            if (matches(list[j])) {
                highlightPhotoMapClusterFromTarget(list[j]);
                return;
            }
        }
    }
    if (photosMarkerClusterGroup && typeof photosMarkerClusterGroup.eachLayer === 'function') {
        photosMarkerClusterGroup.eachLayer(function (layer) {
            if (photoMapClusterHighlightEl) return;
            if (!layer || typeof layer.getChildCount !== 'function' || layer.getChildCount() < 2) return;
            if (matches(layer)) {
                highlightPhotoMapClusterFromTarget(layer);
            }
        });
    }
}

function openPhotoClusterDrawerNow(drawerOptions) {
    const opts = drawerOptions && typeof drawerOptions === 'object' ? drawerOptions : {};
    rememberPhotoMapClusterHighlightRef(opts.lat, opts.lng, opts.sourceMarker);
    if (opts.sourceMarker) {
        highlightPhotoMapClusterFromTarget(opts.sourceMarker);
    } else if (opts.lat != null && opts.lng != null) {
        highlightPhotoMapClusterAt(opts.lat, opts.lng);
    }
    if (
        window.photoClusterDrawerModule &&
        typeof window.photoClusterDrawerModule.openPhotoClusterDrawer === 'function'
    ) {
        window.photoClusterDrawerModule.openPhotoClusterDrawer(opts);
    }
}

function flushPendingClusterDrawer() {
    const map = window.map;
    const pending = pendingClusterDrawer;
    if (!pending || !map) return;
    if (map.getZoom() >= pending.targetZoom) {
        const opts = pending.drawerOptions;
        pendingClusterDrawer = null;
        openPhotoClusterDrawerNow(opts);
        return;
    }
    map.setView([pending.lat, pending.lng], Math.min(pending.targetZoom, map.getZoom() + 2));
}

function scheduleOrOpenClusterDrawer(map, lat, lng, drawerOptions) {
    const opts = Object.assign({}, drawerOptions || {}, { lat, lng });
    const targetZoom = getPhotoClusterDrawerZoom(map);
    if (map.getZoom() < targetZoom) {
        pendingClusterDrawer = { lat, lng, drawerOptions: opts, targetZoom };
        map.setView([lat, lng], Math.min(targetZoom, map.getZoom() + 2));
        return false;
    }
    pendingClusterDrawer = null;
    openPhotoClusterDrawerNow(opts);
    return true;
}

function openClusterDrawerAtMaxZoom(map, lat, lng, drawerOptions) {
    return scheduleOrOpenClusterDrawer(map, lat, lng, drawerOptions);
}

function renderServerPhotoClustersOnMap(clusters) {
    const map = window.map;
    if (!map) return;
    lastServerClusterPayload = Array.isArray(clusters) ? clusters : null;
    clearServerPhotoClusters();
    if (!clusters || !clusters.length) return;
    if (!photosLayerGroup) initPhotosLayer();
    clusters.forEach((cluster) => {
        const lat = Number(cluster.lat);
        const lng = Number(cluster.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        const icon = createServerClusterIcon(Number(cluster.count) || 0, !!cluster.hasThumb);
        const marker = L.marker([lat, lng], { icon });
        marker.on('click', function () {
            const count = Number(cluster.count) || 0;
            openClusterDrawerAtMaxZoom(map, lat, lng, {
                cellKey: cluster.cellKey,
                count,
                title: count ? `${count} photos in area` : 'Photos in area',
                sourceMarker: marker,
            });
        });
        const serverLayer = getPhotosServerClusterLayer();
        if (serverLayer) {
            marker.addTo(serverLayer);
        } else {
            marker.addTo(map);
        }
        serverPhotoClusterMarkers.push(marker);
    });
    updatePhotosLayerControl();
}

function setMapNoGpsClustersFromPayload(clusters) {
    lastNoGpsClusterPayload = Array.isArray(clusters) ? clusters : null;
}

function renderNoGpsTicketClustersOnMap(clusters) {
    const map = window.map;
    if (!map) return;
    lastNoGpsClusterPayload = Array.isArray(clusters) ? clusters : null;
    clearNoGpsTicketClusters();
    if (!clusters || !clusters.length) return;
    if (!photosLayerGroup) initPhotosLayer();
    clusters.forEach((cluster) => {
        const lat = Number(cluster.lat);
        const lng = Number(cluster.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        const count = Number(cluster.count) || 0;
        if (count <= 1) return;
        const icon = createNoGpsTicketClusterIcon(count);
        const marker = L.marker([lat, lng], { icon });
        marker.on('click', function () {
            openClusterDrawerAtMaxZoom(map, lat, lng, {
                cellKey: cluster.cellKey || `nogps:${cluster.ticketBaseNumber || ''}`,
                clusterKind: 'associated_no_gps',
                ticketBaseNumber: cluster.ticketBaseNumber || null,
                count,
                title: `${count} photos without location`,
                sourceMarker: marker,
            });
        });
        const serverLayer = getPhotosServerClusterLayer();
        if (serverLayer) {
            marker.addTo(serverLayer);
        } else {
            marker.addTo(map);
        }
        noGpsTicketClusterMarkers.push(marker);
    });
    updatePhotosLayerControl();
}

function openClientClusterDrawerFromClick(map, latlng, cluster, drawerOptions) {
    const opts = Object.assign({}, drawerOptions || {}, { sourceMarker: cluster });
    if (map.getZoom() >= getPhotoClusterDrawerZoom(map)) {
        pendingClusterDrawer = null;
        openPhotoClusterDrawerNow(opts);
    } else {
        scheduleOrOpenClusterDrawer(map, latlng.lat, latlng.lng, opts);
    }
}

function onPhotoClientClusterClick(e) {
    const map = window.map;
    if (!map || !e || !e.layer) return;
    if (forwardMapClickDuringTicketDraw(e.layer.getLatLng && e.layer.getLatLng())) {
        if (typeof L !== 'undefined' && L.DomEvent && typeof L.DomEvent.stopPropagation === 'function') {
            L.DomEvent.stopPropagation(e);
        }
        return;
    }
    const cluster = e.layer;
    const latlng = cluster.getLatLng();
    if (!latlng) return;
    const childCount = cluster.getChildCount ? cluster.getChildCount() : 0;
    if (typeof L !== 'undefined' && L.DomEvent && typeof L.DomEvent.stopPropagation === 'function') {
        L.DomEvent.stopPropagation(e);
    }
    if (childCount <= 1) {
        const markers = cluster.getAllChildMarkers ? cluster.getAllChildMarkers() : [];
        if (markers[0] && typeof markers[0].fire === 'function') {
            markers[0].fire('click');
        }
        return;
    }
    const markers = cluster.getAllChildMarkers ? cluster.getAllChildMarkers() : [];
    const utils = window.photoMapItemUtils;
    const inlineItems =
        utils && typeof utils.buildClusterInlineItemsFromMarkers === 'function'
            ? utils.buildClusterInlineItemsFromMarkers(markers)
            : [];
    if (inlineItems.length >= 2) {
        openClientClusterDrawerFromClick(map, latlng, cluster, {
            inlineItems,
            count: inlineItems.length,
            title: `${inlineItems.length} photos in area`,
        });
        return;
    }
    const photoIds = [];
    markers.forEach((m) => {
        const fid = m.options && m.options.fileId != null ? Number(m.options.fileId) : NaN;
        if (Number.isFinite(fid)) photoIds.push(fid);
    });
    let drawerOptions = null;
    if (photoIds.length >= 2) {
        drawerOptions = {
            photoIds,
            count: photoIds.length,
            title: `${photoIds.length} photos in area`,
        };
    } else {
        const cellKey = computeCellKeyForLatLng(latlng.lat, latlng.lng, map.getZoom());
        if (cellKey) {
            drawerOptions = {
                cellKey,
                count: childCount,
                title: childCount ? `${childCount} photos in area` : 'Photos in area',
            };
        }
    }
    if (drawerOptions) {
        openClientClusterDrawerFromClick(map, latlng, cluster, drawerOptions);
    }
}

function photosHubFiltersActive() {
    const hub = window.dataHubFiltersModule;
    return !!(hub?.hasActiveFilters?.('photos'));
}

function mergeMapPhotosDeduped(...lists) {
    const seen = new Set();
    const out = [];
    lists.flat().forEach((photo) => {
        if (!photo) return;
        const key = photo.fileId != null ? `f:${photo.fileId}` : String(photo.id || '');
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push(photo);
    });
    return out;
}

function getTicketCentroidForPhotoMap(ticket) {
    if (!ticket?.polygon) return null;
    let poly = null;
    const p = ticket.polygon;
    if (p.type === 'Polygon' && p.coordinates?.[0]) {
        const coords = p.coordinates[0].map((c) => [c[1], c[0]]);
        poly = L.polygon(coords);
    } else if (Array.isArray(p)) {
        const coords = p.map((pt) => (Array.isArray(pt) ? [pt[1], pt[0]] : [pt.lat, pt.lng]));
        poly = L.polygon(coords);
    }
    if (!poly) return null;
    try {
        const bounds = poly.getBounds();
        if (bounds?.isValid?.()) {
            const center = bounds.getCenter();
            return { lat: center.lat, lng: center.lng };
        }
    } catch (_) {
        /* ignore */
    }
    return null;
}

function renderHubFilteredNoGpsPhotos(map) {
    const hub = window.dataHubFiltersModule;
    if (!photosHubFiltersActive() || !hub || !map) return;

    const filters = hub.getFilters('photos');
    if (!filters) return;
    const filtered = hub.applyPhotosFilters(savedPhotos || [], filters);
    const noGpsByTicket = new Map();
    const getCoords = hub.getPhotoCoordinates;

    filtered.forEach((photo) => {
        const coords = getCoords ? getCoords(photo) : null;
        if (coords) return;
        const photoMod = window.photoTicketAssociationModule;
        const ticketId = photoMod?.getPhotoAssociatedTicketId?.(photo);
        if (ticketId == null) return;
        const key = String(ticketId);
        if (!noGpsByTicket.has(key)) {
            noGpsByTicket.set(key, { ticketId, photos: [], fileIds: [] });
        }
        const bucket = noGpsByTicket.get(key);
        bucket.photos.push(photo);
        const fileId = photo.fileId != null ? Number(photo.fileId) : null;
        if (fileId != null) bucket.fileIds.push(fileId);
    });

    const serverLayer = getPhotosServerClusterLayer();
    const tickets = window.ORG_TICKETS || [];

    noGpsByTicket.forEach((bucket) => {
        const ticket = tickets.find(
            (t) => String(t.id) === String(bucket.ticketId) || String(t.ticketId) === String(bucket.ticketId)
        );
        const centroid = getTicketCentroidForPhotoMap(ticket);
        if (!centroid) return;
        const ticketBaseNumber =
            ticket?.ticketNumber != null
                ? String(ticket.ticketNumber)
                : ticket?.ticketId != null
                  ? String(ticket.ticketId)
                  : String(bucket.ticketId);
        const marker = createNoGpsTicketClusterMarker(
            centroid.lat,
            centroid.lng,
            bucket.photos.length,
            {
                clusterKind: 'associated_no_gps',
                ticketBaseNumber,
                cellKey: `nogps:${ticketBaseNumber}`,
                photoIds: bucket.fileIds.length ? bucket.fileIds : null,
            },
            serverLayer || undefined
        );
        if (marker) noGpsTicketClusterMarkers.push(marker);
    });
}

function getPhotosForMapRender() {
    if (typeof window.isCurrentOrgPublicCatalogViewer === 'function' && window.isCurrentOrgPublicCatalogViewer()) {
        return [];
    }
    const viewport =
        window.photoMapLoaderModule && typeof window.photoMapLoaderModule.getMapViewportPhotos === 'function'
            ? window.photoMapLoaderModule.getMapViewportPhotos()
            : [];
    const pending = (savedPhotos || []).filter((p) => p && p.offlinePendingUpload && p.latlng);
    const combined = mergeMapPhotosDeduped(viewport, pending);

    const hub = window.dataHubFiltersModule;
    if (!hub?.hasActiveFilters?.('photos')) {
        return combined;
    }

    const filteredViewport = hub.filterForMap('photos', combined);
    const savedWithGps = (savedPhotos || []).filter(
        (p) =>
            p &&
            ((p.latlng?.lat != null && p.latlng?.lng != null) ||
                (p.lat != null && p.lng != null) ||
                (p.exifData?.gpsLat != null && p.exifData?.gpsLng != null))
    );
    const filteredSaved = hub.filterForMap('photos', savedWithGps);
    return mergeMapPhotosDeduped(filteredViewport, filteredSaved);
}

function openPhotoFromMapItem(item, galleryContext) {
    if (!item) return;
    const baseUrl =
        window.authModule && window.authModule.getApiBaseForMedia
            ? window.authModule.getApiBaseForMedia()
            : window.API_BASE_URL || window.location.origin;
    const stub =
        window.photoMapItemUtils && typeof window.photoMapItemUtils.mapApiPhotoItemToViewerPhoto === 'function'
            ? window.photoMapItemUtils.mapApiPhotoItemToViewerPhoto(item, baseUrl)
            : {
                  id: `map-photo-${item.id}`,
                  fileId: item.id,
                  fileName: item.fileName || 'Photo',
                  createdAt: item.createdAt,
                  thumbnailUrl: item.thumbnailUrl
                      ? item.thumbnailUrl.startsWith('http')
                          ? item.thumbnailUrl
                          : `${baseUrl}${item.thumbnailUrl}`
                      : null,
                  imageUrl: `${baseUrl}/api/data/media/${item.id}/file`,
                  latlng:
                      item.lat != null && item.lng != null
                          ? { lat: Number(item.lat), lng: Number(item.lng) }
                          : null,
                  associatedNoGps: !!item.associatedNoGps,
                  note: typeof item.note === 'string' ? item.note : '',
                  tags: Array.isArray(item.tags) ? item.tags : [],
                  noteLastEditedBy: typeof item.noteLastEditedBy === 'string' ? item.noteLastEditedBy : '',
                  noteLastEditedAt: typeof item.noteLastEditedAt === 'string' ? item.noteLastEditedAt : '',
                  hasWhitePaintMark: item.hasWhitePaintMark === true,
                  uploadedBy: item.uploadedBy != null && item.uploadedBy !== '' ? String(item.uploadedBy) : '',
              };
    if (typeof openPhotoViewer === 'function') openPhotoViewer(stub, stub.fileName, galleryContext);
}

function createPhotoClusterIcon(cluster) {
    const count = cluster.getChildCount();
    const display = count > 99 ? '99+' : String(count);
    return L.divIcon({
        html:
            '<div class="photo-cluster-marker-wrap">' +
            '<div class="photo-marker-icon">' +
            getPhotoMapMarkerIconInnerHtml() +
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
        popupAnchor: [0, -28]
    });
}

function ensurePhotosZoomListener() {
    const map = window.map;
    if (!map || photosZoomListenerBound) return;
    photosZoomListenerBound = true;
    map.on('zoomend', syncPhotosLayerForZoom);
    map.on('zoomend', syncPhotoStackGroupingForZoom);
}

function syncPhotoStackGroupingForZoom() {
    const map = window.map;
    if (!map || map.getZoom() < PHOTO_MARKERS_MIN_ZOOM) {
        photoStackGroupingZoomBracket = null;
        return;
    }
    if (
        typeof window.isCurrentOrgPublicCatalogViewer === 'function' &&
        window.isCurrentOrgPublicCatalogViewer()
    ) {
        return;
    }
    const bracket = map.getZoom() >= PHOTO_CLUSTER_DRAWER_ZOOM ? 'drawer' : 'cluster';
    if (photoStackGroupingZoomBracket === bracket) return;
    photoStackGroupingZoomBracket = bracket;
    if (
        window.photoMapLoaderModule &&
        window.photoMapLoaderModule.lastMapMode === 'clusters'
    ) {
        return;
    }
    reloadPhotosOnMap();
}

function setPhotosHiddenForTicketDraw(hidden) {
    const next = !!hidden;
    if (photosHiddenForTicketDraw === next) return;
    photosHiddenForTicketDraw = next;
    syncPhotosLayerForZoom();
    updatePhotosLayerControl();
}

function forEachTicketDrawPhotoLayer(callback) {
    if (typeof callback !== 'function') return;
    callback(photosLayerGroup);
    const visibleClusters = photosMarkerClusterGroup && photosMarkerClusterGroup._featureGroup;
    if (visibleClusters) callback(visibleClusters);
}

function reapplyTicketDrawPhotoInteraction() {
    if (!window.createTicketOverlayDrawActive) return;
    if (typeof window.syncRenderedFeatureInteractionForPolygonDraw !== 'function') return;
    window.syncRenderedFeatureInteractionForPolygonDraw();
}

/** If a photo pin still receives a tap while a ticket is being drawn, place the point instead of opening the photo. */
function forwardMapClickDuringTicketDraw(latlng) {
    if (!window.createTicketOverlayDrawActive || !window.mapQueryPolygonDrawing) return false;
    const map = window.map;
    if (!map || !latlng || typeof map.fire !== 'function') return true;
    map.fire('click', { latlng: latlng });
    return true;
}

function syncPhotosLayerForZoom() {
    const map = window.map;
    if (!map || !photosLayerGroup) return;
    if (!photosLayerUserEnabled || photosHiddenForTicketDraw) {
        if (map.hasLayer(photosLayerGroup)) map.removeLayer(photosLayerGroup);
        return;
    }
    if (map.getZoom() >= PHOTO_MARKERS_MIN_ZOOM) {
        if (!map.hasLayer(photosLayerGroup)) map.addLayer(photosLayerGroup);
    } else if (map.hasLayer(photosLayerGroup)) {
        map.removeLayer(photosLayerGroup);
    }
}

// Initialize photos layer (marker cluster; gallery drawer instead of spiderfy legs)
let photosClusterClickBound = false;

function initPhotosLayer() {
    if (window.CORE_PRODUCT === true) return;
    const map = window.map;
    if (!photosLayerGroup && map) {
        photosLayerUserEnabled = defaultPhotosLayerVisibleOnLoad();
        photosMarkerClusterGroup =
            typeof L.markerClusterGroup === 'function'
                ? L.markerClusterGroup({
                      // Smaller = cluster only when markers are closer on screen (pixels from cluster center)
                      maxClusterRadius: 22,
                      spiderfyOnMaxZoom: false,
                      showCoverageOnHover: false,
                      zoomToBoundsOnClick: false,
                      iconCreateFunction: createPhotoClusterIcon,
                  })
                : null;
        photosServerClusterLayer = L.layerGroup();
        photosLayerGroup = L.layerGroup();
        if (photosMarkerClusterGroup) {
            photosLayerGroup.addLayer(photosMarkerClusterGroup);
        }
        photosLayerGroup.addLayer(photosServerClusterLayer);
        if (
            !photosClusterClickBound &&
            photosMarkerClusterGroup &&
            typeof photosMarkerClusterGroup.on === 'function'
        ) {
            photosClusterClickBound = true;
            photosMarkerClusterGroup.on('clusterclick', onPhotoClientClusterClick);
            photosMarkerClusterGroup.on('animationend', reapplyTicketDrawPhotoInteraction);
        }
        if (!photosClusterDrawerZoomBound) {
            photosClusterDrawerZoomBound = true;
            map.on('zoomend', flushPendingClusterDrawer);
        }
        ensurePhotosZoomListener();
        syncPhotosLayerForZoom();
        updatePhotosLayerControl();
    }
    return photosLayerGroup;
}

function getEffectiveTimeWarpConstraints() {
    const mod = window.aerialMapPanelModule;
    if (mod && typeof mod.getTimeWarpConstraints === 'function') {
        return mod.getTimeWarpConstraints();
    }
    return null;
}

function photoTimeWarpMs(photo) {
    if (!photo || !photo.createdAt) return null;
    const t = new Date(photo.createdAt).getTime();
    return Number.isNaN(t) ? null : t;
}

function timeWarpFilterActive(c) {
    if (!c || !c.zoomOk) return false;
    if (c.timeActive) return true;
    if (c.search && String(c.search).trim()) return true;
    if (c.viewportOnly && c.viewportBounds) return true;
    return false;
}

function photoPassesRecentWindow(photo) {
    if (photo && photo.mapViewport) return true;
    const mod = window.photoTicketAssociationModule;
    if (!mod || typeof mod.photoMatchesRecentWindow !== 'function') return true;
    return mod.photoMatchesRecentWindow(photo);
}

function photoPassesTimeWarp(photo) {
    const c = getEffectiveTimeWarpConstraints();
    if (!timeWarpFilterActive(c)) return true;

    if (c.timeActive && c.startMs != null && c.endMs != null) {
        const ms = photoTimeWarpMs(photo);
        if (ms != null && (ms < c.startMs || ms > c.endMs)) return false;
    }

    if (c.viewportOnly && c.viewportBounds && photo.latlng) {
        const lat = Number(photo.latlng.lat);
        const lng = Number(photo.latlng.lng);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            const ll = L.latLng(lat, lng);
            if (!c.viewportBounds.contains(ll)) return false;
        }
    }

    if (c.search && String(c.search).trim()) {
        const q = String(c.search).trim().toLowerCase();
        const name = (photo.fileName || '').toLowerCase();
        const note = (photo.note || '').toLowerCase();
        const tagLine = ((window.photoTagsModule && window.photoTagsModule.getPhotoTags(photo)) || [])
            .join(' ')
            .toLowerCase();
        if (!name.includes(q) && !note.includes(q) && !tagLine.includes(q)) return false;
    }

    return true;
}

function isPhotosLayerUserEnabled() {
    return !!photosLayerUserEnabled;
}

// Clear all photo markers from map (e.g. when switching organization)
function clearPhotosFromMap() {
    clearPhotoMapChildLayers();
    savedPhotos.forEach(photo => {
        photo.marker = null;
    });
    updatePhotosLayerControl();
}

// Reload photos on map from viewport API (+ offline pending), not full savedPhotos archive.
function reloadPhotosOnMap() {
    const map = window.map;
    if (!map) return;

    if (
        typeof window.isCurrentOrgPublicCatalogViewer === 'function' &&
        window.isCurrentOrgPublicCatalogViewer()
    ) {
        if (!photosLayerGroup) {
            initPhotosLayer();
        }
        renderPublicSearchPhotosOnMap();
        finishReloadPhotosOnMap(map);
        return;
    }

    if (!photosLayerGroup) {
        initPhotosLayer();
    }
    clearPhotoMapClusterHighlight();
    clearPhotoMapChildLayers();
    clearServerPhotoClusters();
    clearNoGpsTicketClusters();
    clearCoincidentPhotoStackMarkers();

    const mapPhotos = getPhotosForMapRender();
    mapPhotos.forEach((photo) => {
        photo.marker = null;
    });

    const hubFiltersActive = photosHubFiltersActive();

    if (
        !hubFiltersActive &&
        window.photoMapLoaderModule &&
        window.photoMapLoaderModule.lastMapMode === 'clusters'
    ) {
        if (lastServerClusterPayload && lastServerClusterPayload.length) {
            renderServerPhotoClustersOnMap(lastServerClusterPayload);
        }
        if (lastNoGpsClusterPayload && lastNoGpsClusterPayload.length) {
            renderNoGpsTicketClustersOnMap(lastNoGpsClusterPayload);
        }
        finishReloadPhotosOnMap(map);
        return;
    }

    if (!hubFiltersActive) {
        lastServerClusterPayload = null;
    }

    if (!mapPhotos || mapPhotos.length === 0) {
        if (hubFiltersActive) {
            renderHubFilteredNoGpsPhotos(map);
        } else if (lastNoGpsClusterPayload && lastNoGpsClusterPayload.length) {
            renderNoGpsTicketClustersOnMap(lastNoGpsClusterPayload);
        }
        finishReloadPhotosOnMap(map);
        return;
    }

    const eligible = filterPhotosEligibleForMapMarkers(mapPhotos);
    const useCoincidentStacks = map.getZoom() >= PHOTO_CLUSTER_DRAWER_ZOOM;
    const partitioned = useCoincidentStacks ? partitionCoincidentPhotoStacks(eligible) : null;
    const pointPhotos = partitioned ? partitioned.singles : eligible;
    const coincidentStacks = partitioned ? partitioned.stacks : [];

    pointPhotos.forEach((photo) => {
        addPhotoPointMarkerToMap(photo, map);
    });
    renderCoincidentPhotoStackMarkers(coincidentStacks);

    if (hubFiltersActive) {
        renderHubFilteredNoGpsPhotos(map);
    } else if (lastNoGpsClusterPayload && lastNoGpsClusterPayload.length) {
        renderNoGpsTicketClustersOnMap(lastNoGpsClusterPayload);
    }

    finishReloadPhotosOnMap(map);
}

function finishReloadPhotosOnMap(map) {
    updatePhotoStackGroupingBracket(map);
    updatePhotosLayerControl();
    restorePhotoMapClusterHighlightIfDrawerOpen();
    reapplyTicketDrawPhotoInteraction();
}

let publicSearchPhotoMarkers = [];

function clearPublicSearchPhotosFromMap() {
    const publicCatalogMode =
        typeof window.isCurrentOrgPublicCatalogViewer === 'function' && window.isCurrentOrgPublicCatalogViewer();

    publicSearchPhotoMarkers.forEach((marker) => {
        if (!marker) return;
        // Markers are added to photosLayerGroup/MarkerClusterGroup, not directly to the map.
        // Remove from that owner first; marker.remove() can leave cluster registrations behind.
        if (photosMarkerClusterGroup && typeof photosMarkerClusterGroup.removeLayer === 'function') {
            photosMarkerClusterGroup.removeLayer(marker);
        } else if (photosLayerGroup && typeof photosLayerGroup.removeLayer === 'function') {
            photosLayerGroup.removeLayer(marker);
        } else if (typeof marker.remove === 'function') {
            marker.remove();
        } else if (window.map && window.map.hasLayer(marker)) {
            window.map.removeLayer(marker);
        }
    });
    publicSearchPhotoMarkers = [];

    // Public Data mode only renders searched public photos into this group, so a full clear is safe
    // and catches stale cluster children from older builds/sessions that were not tracked above.
    if (publicCatalogMode) {
        clearPhotoMapChildLayers();
    }
}

function renderPublicSearchPhotosOnMap() {
    const map = window.map;
    if (!map) return;
    clearPublicSearchPhotosFromMap();
    const rows = window.PUBLIC_MAP_PHOTOS || [];
    if (!rows.length) return;

    if (!photosLayerGroup) initPhotosLayer();

    const baseUrl = (window.authModule && window.authModule.getApiBaseForMedia)
        ? window.authModule.getApiBaseForMedia()
        : (window.API_BASE_URL || window.location.origin);

    rows.forEach((file) => {
        const lat = file.latitude != null ? Number(file.latitude) : NaN;
        const lng = file.longitude != null ? Number(file.longitude) : NaN;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

        const imageUrl = `${baseUrl}/api/data/media/${file.id}/file`;
        const photoStub = {
            id: `public-photo-${file.id}`,
            fileId: file.id,
            imageUrl,
            thumbnailUrl: file.thumbnailUrl || (file.thumbnailPath ? `/api/data/media/${file.id}/thumbnail` : undefined),
            fileName: file.fileName || 'Photo',
            shared: true,
            sharedSourceLabel: file.sharedSourceLabel,
            readOnly: true,
            associatedNoGps: !!file.associatedNoGps,
        };
        const photoIcon = L.divIcon({
            className: getPhotoMapMarkerClassName(photoStub),
            html: getPhotoMapMarkerIconHtml(photoStub),
            iconSize: [32, 32],
            iconAnchor: [16, 32],
            popupAnchor: [0, -32],
        });
        const marker = L.marker([lat, lng], { icon: photoIcon, fileId: file.id });
        marker._publicPhotoStub = photoStub;
        marker.bindPopup(buildPhotoMapPopupHtml(photoStub), { autoPan: false });
        marker.on('popupopen', function () {
            const el = this.getPopup().getElement();
            if (el && setServerPhotoImageSources) setServerPhotoImageSources(el);
            if (typeof bindPhotoPopupNoteButton === 'function') bindPhotoPopupNoteButton(el);
            if (typeof centerMapOnPhotoPopup === 'function') centerMapOnPhotoPopup(this);
        });
        wirePhotoMapMarkerLeafletMobile(marker);
        const pointLayer = getPhotosPointMarkerLayer();
        if (pointLayer) {
            marker.addTo(pointLayer);
        } else {
            marker.addTo(map);
        }
        publicSearchPhotoMarkers.push(marker);
    });
    updatePhotosLayerControl();
}

function replaceOrgPhotosFromOfflineCache(orgId, photos, batches, pendingPhotos) {
    const oid = Number(orgId);
    const other = savedPhotos.filter((p) => Number(p.organizationId) !== oid);
    savedPhotos = other.concat(Array.isArray(photos) ? photos : []).concat(Array.isArray(pendingPhotos) ? pendingPhotos : []);
    photoBatches = Array.isArray(batches) ? batches.filter((b) => Number(b.organizationId) === oid) : [];
    savePhotos();
    savePhotoBatches();
}

async function fetchThumbnailBlobForOffline(fileId) {
    try {
        return await fetchPhotoThumbnailBlob(fileId);
    } catch (e) {
        console.warn('[photos] offline thumbnail prefetch:', e.message || e);
        return null;
    }
}

function revokeOfflineBlobPreview(photo) {
    if (!photo) return;
    if (
        photo._offlineThumbPreview &&
        photo.thumbnailUrl &&
        typeof photo.thumbnailUrl === 'string' &&
        photo.thumbnailUrl.startsWith('blob:')
    ) {
        try {
            URL.revokeObjectURL(photo.thumbnailUrl);
        } catch (_e) {
            /* non-fatal */
        }
        photo._offlineThumbPreview = false;
        photo.thumbnailUrl = null;
    }
    if (
        photo._offlineBlobPreview &&
        photo.imageUrl &&
        typeof photo.imageUrl === 'string' &&
        photo.imageUrl.startsWith('blob:')
    ) {
        try {
            URL.revokeObjectURL(photo.imageUrl);
        } catch (_e) {
            /* non-fatal */
        }
        photo._offlineBlobPreview = false;
    }
}

function findOfflinePhotoIndex(entry) {
    if (!entry) return -1;
    const lr = entry.localPhotoRecord;
    const clientId = entry.clientPhotoId || (lr && lr.offlineClientPhotoId);
    const localId = lr && lr.id;
    return savedPhotos.findIndex((p) => {
        if (!p) return false;
        if (localId && p.id === localId) return true;
        if (clientId && p.offlineClientPhotoId === clientId) return true;
        if (localId && p.note === localId) return true;
        return false;
    });
}

function buildPhotoFromOfflineUploadEntry(entry, result, baseUrl) {
    const lr = entry.localPhotoRecord || {};
    const fileUrl = result.url ? `${baseUrl}${result.url}` : `${baseUrl}/api/data/media/${result.id}/file`;
    const thumbnailUrl = result.thumbnailUrl ? `${baseUrl}${result.thumbnailUrl}` : null;
    const latlng =
        lr.latlng ||
        (entry.latlng && Number.isFinite(entry.latlng.lat) && Number.isFinite(entry.latlng.lng)
            ? { lat: entry.latlng.lat, lng: entry.latlng.lng }
            : null);
    return {
        id: lr.id || `photo-${result.id}`,
        offlineClientPhotoId: entry.clientPhotoId || lr.offlineClientPhotoId || null,
        offlinePendingUpload: false,
        latlng,
        fileName: lr.fileName || entry.originalFileName || 'photo.jpg',
        originalFileName: lr.originalFileName || entry.originalFileName || lr.fileName || 'photo.jpg',
        exifData: lr.exifData || entry.exifData || {},
        createdAt: lr.createdAt || entry.capturedAt || new Date().toISOString(),
        batchId: lr.batchId || null,
        organizationId: lr.organizationId != null ? lr.organizationId : entry.orgId,
        fileId: result.id,
        imageUrl: fileUrl,
        thumbnailUrl,
        uploadedBy: lr.uploadedBy || result.uploadedBy || '',
        note: '',
        marker: null,
    };
}

function migratePhotoBatchIds(oldPhotoId, newPhotoId) {
    if (!oldPhotoId || !newPhotoId || oldPhotoId === newPhotoId) return;
    photoBatches.forEach((batch) => {
        if (!Array.isArray(batch.photoIds)) return;
        const idx = batch.photoIds.indexOf(oldPhotoId);
        if (idx >= 0) batch.photoIds[idx] = newPhotoId;
    });
    savePhotoBatches();
}

function reconcileOfflineUploadSuccess(entry, result) {
    if (!entry || !result || result.id == null) return;
    const baseUrl =
        window.authModule && window.authModule.getApiBaseForMedia
            ? window.authModule.getApiBaseForMedia()
            : window.API_BASE_URL || window.location.origin;
    const serverPhotoId = `photo-server-${result.id}`;
    const patch = {
        id: serverPhotoId,
        fileId: result.id,
        imageUrl: result.url ? `${baseUrl}${result.url}` : `${baseUrl}/api/data/media/${result.id}/file`,
        thumbnailUrl: result.thumbnailUrl ? `${baseUrl}${result.thumbnailUrl}` : null,
        offlinePendingUpload: false,
        offlineClientPhotoId: null,
    };
    const idx = findOfflinePhotoIndex(entry);
    let synced;
    if (idx >= 0) {
        const oldId = savedPhotos[idx].id;
        revokeOfflineBlobPreview(savedPhotos[idx]);
        Object.assign(savedPhotos[idx], patch);
        migratePhotoBatchIds(oldId, serverPhotoId);
        synced = savedPhotos[idx];
    } else {
        synced = buildPhotoFromOfflineUploadEntry(entry, result, baseUrl);
        synced.id = serverPhotoId;
        synced.offlineClientPhotoId = null;
        savedPhotos.push(synced);
    }
    const clientPhotoId =
        entry.clientPhotoId || (entry.localPhotoRecord && entry.localPhotoRecord.offlineClientPhotoId);
    if (window.offlinePhotos && typeof window.offlinePhotos.removeOfflineThumbnail === 'function') {
        void window.offlinePhotos.removeOfflineThumbnail(clientPhotoId);
    }
    savePhotos();
    if (window.offlinePhotos && typeof window.offlinePhotos.persistPhotoMetaFromMemory === 'function') {
        void window.offlinePhotos.persistPhotoMetaFromMemory(entry.orgId);
    }
    invalidateManageDataPhotosSync();
    if (window.photoMapLoaderModule && typeof window.photoMapLoaderModule.invalidatePhotoMapCache === 'function') {
        window.photoMapLoaderModule.invalidatePhotoMapCache();
    }
    if (reloadPhotosOnMap) reloadPhotosOnMap();
    if (window.refreshDataWindow) window.refreshDataWindow();
    if (window.ticketsModule && typeof window.ticketsModule.refreshTicketUiAfterPhotoChange === 'function') {
        window.ticketsModule.refreshTicketUiAfterPhotoChange(synced, 'photo-upload');
    }
}

