// Map API / cluster photo items to viewer and viewport photo shapes.

/**
 * @param {object} item
 * @returns {{ lat: number, lng: number }|null}
 */
function getLatLngFromMapPhotoItem(item) {
    if (!item || typeof item !== 'object') return null;
    const lat = Number(item.lat != null ? item.lat : item.latitude);
    const lng = Number(item.lng != null ? item.lng : item.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat: lat, lng: lng };
}

/**
 * @param {object} item
 * @returns {object|null}
 */
function buildExifDataFromMapPhotoItem(item) {
    if (!item || typeof item !== 'object') return null;
    const exifData = {};
    const hasGps = !!getLatLngFromMapPhotoItem(item) || item.hasGps === true;
    if (hasGps) {
        exifData.hasGPS = true;
        const ll = getLatLngFromMapPhotoItem(item);
        if (ll) {
            exifData.gpsLat = ll.lat;
            exifData.gpsLng = ll.lng;
        }
        exifData.gpsSource = item.gpsSource || 'EXIF';
    }
    const acc = item.gpsAccuracyMeters != null ? Number(item.gpsAccuracyMeters) : null;
    if (acc != null && Number.isFinite(acc)) {
        exifData.gpsAccuracyMeters = acc;
    }
    const headingM = item.gpsHeadingDegrees != null ? Number(item.gpsHeadingDegrees) : null;
    if (headingM != null && Number.isFinite(headingM)) {
        exifData.gpsHeadingDegrees = headingM;
        if (item.gpsHeadingSource != null && String(item.gpsHeadingSource).trim() !== '') {
            exifData.gpsHeadingSource = String(item.gpsHeadingSource);
        }
    }
    if (item.dateTime != null && String(item.dateTime).trim() !== '') {
        exifData.dateTime = String(item.dateTime).trim();
    } else if (item.createdAt != null && String(item.createdAt).trim() !== '') {
        exifData.dateTime = String(item.createdAt).trim();
    }
    return Object.keys(exifData).length ? exifData : null;
}

/**
 * @param {object} item
 * @param {string} apiBase
 * @param {{ idPrefix?: string }} [options]
 * @returns {object}
 */
/**
 * @param {number|string} fileId
 * @returns {object|null}
 */
function findMapPhotoByFileId(fileId) {
    const fid = Number(fileId);
    if (!Number.isFinite(fid) || fid <= 0) return null;
    const loader = window.photoMapLoaderModule;
    if (loader && typeof loader.getMapViewportPhotos === 'function') {
        const viewportHit = loader.getMapViewportPhotos().find((p) => p && Number(p.fileId) === fid);
        if (viewportHit) return viewportHit;
    }
    const saved = window.photosModule && window.photosModule.savedPhotos;
    if (Array.isArray(saved)) {
        const savedHit = saved.find((p) => p && Number(p.fileId) === fid);
        if (savedHit) return savedHit;
    }
    return null;
}

/**
 * Map marker / viewport photo to cluster drawer inline item shape.
 * @param {object} photo
 * @param {{ lat: number, lng: number }|null} [latLngOverride]
 * @returns {object|null}
 */
function clusterInlineItemFromMapPhoto(photo, latLngOverride) {
    if (!photo || typeof photo !== 'object') return null;
    const fileId = photo.fileId != null ? Number(photo.fileId) : NaN;
    if (!Number.isFinite(fileId) || fileId <= 0) return null;

    const ll =
        latLngOverride && Number.isFinite(Number(latLngOverride.lat)) && Number.isFinite(Number(latLngOverride.lng))
            ? { lat: Number(latLngOverride.lat), lng: Number(latLngOverride.lng) }
            : getLatLngFromMapPhotoItem(photo) ||
              (photo.latlng && Number.isFinite(Number(photo.latlng.lat)) && Number.isFinite(Number(photo.latlng.lng))
                  ? { lat: Number(photo.latlng.lat), lng: Number(photo.latlng.lng) }
                  : null);

    const item = {
        id: fileId,
        fileName: photo.fileName || 'Photo',
        thumbnailUrl: photo.thumbnailUrl || null,
        createdAt: photo.createdAt,
        associatedNoGps: !!photo.associatedNoGps,
        lat: ll ? ll.lat : null,
        lng: ll ? ll.lng : null,
        note: typeof photo.note === 'string' ? photo.note : '',
        tags: Array.isArray(photo.tags) ? photo.tags : [],
        noteLastEditedBy: typeof photo.noteLastEditedBy === 'string' ? photo.noteLastEditedBy : '',
        noteLastEditedAt: typeof photo.noteLastEditedAt === 'string' ? photo.noteLastEditedAt : '',
        hasWhitePaintMark: photo.hasWhitePaintMark === true,
        uploadedBy: photo.uploadedBy != null && photo.uploadedBy !== '' ? String(photo.uploadedBy) : '',
    };

    const exif = photo.exifData && typeof photo.exifData === 'object' ? photo.exifData : {};
    const headingM = exif.gpsHeadingDegrees != null ? Number(exif.gpsHeadingDegrees) : null;
    if (headingM != null && Number.isFinite(headingM)) {
        item.gpsHeadingDegrees = headingM;
        if (exif.gpsHeadingSource != null && String(exif.gpsHeadingSource).trim() !== '') {
            item.gpsHeadingSource = String(exif.gpsHeadingSource);
        }
    }
    const accM = exif.gpsAccuracyMeters != null ? Number(exif.gpsAccuracyMeters) : null;
    if (accM != null && Number.isFinite(accM)) {
        item.gpsAccuracyMeters = accM;
    }
    return item;
}

/**
 * Cluster drawer card label: date/time + GPS (falls back to file name).
 * @param {object} item
 * @returns {string}
 */
function formatClusterCardLabel(item) {
    if (!item || typeof item !== 'object') return 'Photo';
    const lines = [];
    if (item.createdAt != null && String(item.createdAt).trim() !== '' && typeof window.formatRecordedDateTime === 'function') {
        const when = window.formatRecordedDateTime(item.createdAt);
        if (when && when !== '—') lines.push(when);
    }
    let lat = item.lat != null ? Number(item.lat) : NaN;
    let lng = item.lng != null ? Number(item.lng) : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        const ll = getLatLngFromMapPhotoItem(item);
        if (ll) {
            lat = ll.lat;
            lng = ll.lng;
        }
    }
    if (Number.isFinite(lat) && Number.isFinite(lng) && typeof window.formatLatLng === 'function') {
        const coords = window.formatLatLng(lat, lng);
        if (coords && coords !== '—') lines.push(coords);
    }
    if (lines.length) return lines.join('\n');
    return item.fileName || 'Photo';
}

/**
 * @param {object[]} markers Leaflet markers from a client-side cluster
 * @returns {object[]}
 */
function buildClusterInlineItemsFromMarkers(markers) {
    const inlineItems = [];
    const seen = new Set();
    (markers || []).forEach((m) => {
        const stub = m && m._publicPhotoStub;
        const fid =
            stub && stub.fileId != null
                ? Number(stub.fileId)
                : m && m.options && m.options.fileId != null
                  ? Number(m.options.fileId)
                  : NaN;
        if (!Number.isFinite(fid) || seen.has(fid)) return;
        seen.add(fid);
        const markerLatLng = m && typeof m.getLatLng === 'function' ? m.getLatLng() : null;
        const photo = stub || findMapPhotoByFileId(fid);
        const item = photo
            ? clusterInlineItemFromMapPhoto(photo, markerLatLng)
            : {
                  id: fid,
                  fileName: 'Photo',
                  lat: markerLatLng ? markerLatLng.lat : null,
                  lng: markerLatLng ? markerLatLng.lng : null,
              };
        if (item) inlineItems.push(item);
    });
    return inlineItems;
}

function mapApiPhotoItemToViewerPhoto(item, apiBase, options) {
    const base = String(apiBase || '').replace(/\/api$/, '');
    const thumb = item.thumbnailUrl
        ? item.thumbnailUrl.startsWith('http')
            ? item.thumbnailUrl
            : base + item.thumbnailUrl
        : null;
    const idPrefix = options && options.idPrefix ? options.idPrefix : 'map-photo-';
    const latlng = getLatLngFromMapPhotoItem(item);
    const exifData = buildExifDataFromMapPhotoItem(item);
    const photo = {
        id: idPrefix + item.id,
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
    if (latlng) photo.latlng = latlng;
    if (exifData) photo.exifData = exifData;
    return photo;
}

if (typeof window !== 'undefined') {
    window.photoMapItemUtils = {
        getLatLngFromMapPhotoItem,
        buildExifDataFromMapPhotoItem,
        mapApiPhotoItemToViewerPhoto,
        findMapPhotoByFileId,
        clusterInlineItemFromMapPhoto,
        buildClusterInlineItemsFromMarkers,
        formatClusterCardLabel,
    };
}
