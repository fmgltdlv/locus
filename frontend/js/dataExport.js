// Data Export module - Export functionality (GeoJSON, KML, CSV, SHP, ZIP, Photos)

const EXPORT_MAX_SIZE = 25 * 1024 * 1024;
const PHOTO_EXPORT_MAX_SIZE = 100 * 1024 * 1024;
const PHOTO_EXPORT_MAX_COUNT = 100;
const PHOTO_EXPORT_CONCURRENCY = 3;

const GEOMETRY_GROUP_MAP = {
    Point: 'points',
    MultiPoint: 'points',
    LineString: 'lines',
    MultiLineString: 'lines',
    Polygon: 'polygons',
    MultiPolygon: 'polygons'
};

function getExportDateSuffix() {
    return new Date().toISOString().split('T')[0];
}

function sanitizeExportName(name) {
    return (name || 'unnamed').replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

function sanitizePhotoExportFileName(name) {
    const base = String(name || 'photo').replace(/[/\\:*?"<>|]/g, '_').trim();
    return base || 'photo';
}

function forceJpegExportFileName(name) {
    const sanitized = sanitizePhotoExportFileName(name);
    if (/\.jpe?g$/i.test(sanitized)) return sanitized.replace(/\.jpe?g$/i, '.jpg');
    const dot = sanitized.lastIndexOf('.');
    const stem = dot > 0 ? sanitized.slice(0, dot) : sanitized;
    return (stem || 'photo') + '.jpg';
}

function normalizeEpsgCode(input) {
    const trimmed = String(input || '').trim().toUpperCase();
    if (!trimmed) return null;
    if (trimmed.startsWith('EPSG:')) return trimmed;
    if (/^\d+$/.test(trimmed)) return 'EPSG:' + trimmed;
    return trimmed;
}

function validateEpsgCode(epsg) {
    if (!epsg || typeof proj4 === 'undefined') return false;
    try {
        proj4('EPSG:4326', epsg, [0, 0]);
        return true;
    } catch (error) {
        return false;
    }
}

function escapeCsv(text) {
    if (text === null || text === undefined) return '';
    const str = String(text);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

function annotationToFeature(annotation) {
    return {
        type: 'Feature',
        geometry: annotation.geometry,
        properties: {
            name: annotation.name || '',
            note: annotation.note || '',
            color: annotation.color || 'var(--app-accent)',
            type: annotation.type || '',
            icon: annotation.icon || '',
            createdAt: annotation.createdAt || ''
        }
    };
}

function buildFeatureCollectionFromAnnotations(annotations) {
    return {
        type: 'FeatureCollection',
        features: annotations.map(annotationToFeature)
    };
}

function buildLayerFeatureCollection(layer) {
    return {
        type: 'FeatureCollection',
        features: (layer.annotations || []).map(annotation => {
            const feature = annotationToFeature(annotation);
            feature.properties.layerName = layer.name || '';
            return feature;
        })
    };
}

function buildExportUnitsFromLayers(layers, fileMode) {
    if (fileMode === 'single') {
        const features = [];
        for (const layer of layers) {
            if (!layer.annotations || layer.annotations.length === 0) continue;
            for (const annotation of layer.annotations) {
                const feature = annotationToFeature(annotation);
                feature.properties.layerName = layer.name || '';
                features.push(feature);
            }
        }
        return [{
            baseName: `data-layers-${getExportDateSuffix()}`,
            geojson: { type: 'FeatureCollection', features }
        }];
    }

    const units = [];
    for (const layer of layers) {
        if (!layer.annotations || layer.annotations.length === 0) continue;
        units.push({
            baseName: sanitizeExportName(layer.name || 'unnamed-layer'),
            geojson: buildLayerFeatureCollection(layer)
        });
    }
    return units;
}

function maybeReprojectGeoJSON(geojson, options) {
    if (!options.reproject) return geojson;
    const target = options.targetEpsg;
    if (!target || !validateEpsgCode(target)) {
        throw new Error(typeof t === 'function'
            ? t('Invalid EPSG code. Please enter a valid code like EPSG:3857.')
            : 'Invalid EPSG code. Please enter a valid code like EPSG:3857.');
    }
    const transform = window.fileImportModule?.transformGeoJSONCoordinates;
    if (!transform) {
        throw new Error(typeof t === 'function'
            ? t('Reprojection helper not loaded. Please refresh the page.')
            : 'Reprojection helper not loaded. Please refresh the page.');
    }
    return transform(geojson, 'EPSG:4326', target);
}

function groupFeaturesByGeometryType(geojson) {
    const groups = {};
    for (const feature of geojson.features || []) {
        const geomType = feature.geometry?.type;
        const key = GEOMETRY_GROUP_MAP[geomType] || 'other';
        if (!groups[key]) groups[key] = [];
        groups[key].push(feature);
    }
    return groups;
}

function convertToExportBlob(geojson, format, baseName) {
    if (format === 'geojson') {
        const jsonString = JSON.stringify(geojson, null, 2);
        return {
            blob: new Blob([jsonString], { type: 'application/geo+json' }),
            filename: `${baseName}.geojson`,
            mimeType: 'application/geo+json'
        };
    }
    if (format === 'kml') {
        const kml = convertGeoJSONToKML(geojson);
        return {
            blob: new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }),
            filename: `${baseName}.kml`,
            mimeType: 'application/vnd.google-earth.kml+xml'
        };
    }
    throw new Error('Unsupported export format: ' + format);
}

function convertToShpOutputs(geojson, baseName) {
    if (typeof shpwrite === 'undefined') {
        throw new Error(typeof t === 'function'
            ? t('SHP library not loaded. Please refresh the page.')
            : 'SHP library not loaded. Please refresh the page.');
    }

    const groups = groupFeaturesByGeometryType(geojson);
    const keys = Object.keys(groups).filter(key => groups[key].length > 0);
    if (keys.length === 0) {
        throw new Error(typeof t === 'function'
            ? t('No exportable features found.')
            : 'No exportable features found.');
    }

    const outputs = [];
    for (const key of keys) {
        const featureCollection = { type: 'FeatureCollection', features: groups[key] };
        const zipBlob = shpwrite.zip(featureCollection, { outputType: 'blob', compression: 'DEFLATE' });
        const suffix = keys.length > 1 ? `-${key}` : '';
        outputs.push({
            blob: zipBlob,
            filename: `${baseName}${suffix}.zip`,
            mimeType: 'application/zip'
        });
    }
    return outputs;
}

function convertUnitToOutputs(geojson, format, baseName) {
    if (format === 'shp') {
        return convertToShpOutputs(geojson, baseName);
    }
    return [convertToExportBlob(geojson, format, baseName)];
}

function checkExportSize(outputs, maxSize) {
    const limit = maxSize != null ? maxSize : EXPORT_MAX_SIZE;
    const totalSize = outputs.reduce((sum, item) => sum + item.blob.size, 0);
    if (totalSize > limit) {
        const sizeMB = (totalSize / (1024 * 1024)).toFixed(2);
        const limitMB = (limit / (1024 * 1024)).toFixed(0);
        throw new Error(
            (typeof t === 'function'
                ? t('Export file size ({sizeMB} MB) exceeds the {limitMB} MB limit.\n\nPlease select fewer items or contact us for assistance with larger exports.', { sizeMB, limitMB })
                : `Export file size (${sizeMB} MB) exceeds the ${limitMB} MB limit.\n\nPlease select fewer items or contact us for assistance with larger exports.`)
        );
    }
}

async function deliverExportOutputs(outputs, archiveName, maxSize) {
    checkExportSize(outputs, maxSize);

    if (outputs.length === 1) {
        const item = outputs[0];
        downloadBlob(item.blob, item.filename, item.mimeType);
        return;
    }

    if (typeof JSZip === 'undefined') {
        throw new Error(typeof t === 'function'
            ? t('ZIP library not loaded. Please refresh the page.')
            : 'ZIP library not loaded. Please refresh the page.');
    }

    const zip = new JSZip();
    for (const item of outputs) {
        zip.file(item.filename, item.blob);
    }

    const content = await zip.generateAsync({ type: 'blob' });
    checkExportSize([{ blob: content }], maxSize);
    downloadBlob(content, archiveName, 'application/zip');
}

function getSelectedPhotos() {
    const selectedDataIds = window.dataSelectionModule?.selectedDataIds || new Set();
    const photos = window.photosModule?.savedPhotos || [];
    const selected = photos.filter(p => selectedDataIds.has(p.id));
    if (selected.length === 0) {
        throw new Error(typeof t === 'function' ? t('No photos selected.') : 'No photos selected.');
    }
    return selected;
}

function getPhotoBatchDisplayName(photo) {
    if (!photo?.batchId) return '';
    const batches = window.photosModule?.photoBatches || [];
    const batch = batches.find(b => b.id === photo.batchId);
    if (!batch) return String(photo.batchId);
    if (window.photosModule?.getPhotoBatchDisplayPrimaryLabel) {
        return window.photosModule.getPhotoBatchDisplayPrimaryLabel(batch);
    }
    return batch.name || String(photo.batchId);
}

function getPhotoBatchFolderName(photo) {
    if (!photo?.batchId) return '_unbatched';
    const label = getPhotoBatchDisplayName(photo);
    return sanitizeExportName(label) || 'batch';
}

function dedupeZipEntryPath(path, usedPaths) {
    const normalized = String(path || 'photo').replace(/\\/g, '/');
    if (!usedPaths.has(normalized)) {
        usedPaths.add(normalized);
        return normalized;
    }
    const lastSlash = normalized.lastIndexOf('/');
    const folder = lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : '';
    const filePart = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
    const dot = filePart.lastIndexOf('.');
    const stem = dot > 0 ? filePart.slice(0, dot) : filePart;
    const ext = dot > 0 ? filePart.slice(dot) : '';
    let n = 2;
    while (usedPaths.has(`${folder}${stem}-${n}${ext}`)) {
        n += 1;
    }
    const unique = `${folder}${stem}-${n}${ext}`;
    usedPaths.add(unique);
    return unique;
}

function buildPhotoZipPaths(photos, layout, forceJpegExt) {
    const usedPaths = new Set();
    const pathByPhotoId = new Map();
    for (const photo of photos) {
        const rawName = photo.fileName || photo.originalFileName || 'photo';
        const fileName = forceJpegExt
            ? forceJpegExportFileName(rawName)
            : sanitizePhotoExportFileName(rawName);
        let zipPath = fileName;
        if (layout === 'by_batch') {
            const folder = getPhotoBatchFolderName(photo);
            zipPath = `${folder}/${fileName}`;
        }
        pathByPhotoId.set(photo.id, dedupeZipEntryPath(zipPath, usedPaths));
    }
    return pathByPhotoId;
}

function photoHasGps(photo) {
    const lat = Number(photo?.latlng?.lat);
    const lng = Number(photo?.latlng?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng);
}

function photoExportHeadingFields(photo) {
    const utils = window.photoCanvasUtils;
    if (!utils || typeof utils.photoHasHeading !== 'function' || !utils.photoHasHeading(photo)) {
        return { heading_degrees: '', heading_azimuth: '', heading_source: '' };
    }
    const deg = typeof utils.getPhotoHeadingDegrees === 'function' ? utils.getPhotoHeadingDegrees(photo) : null;
    const az =
        deg != null && typeof utils.formatPhotoHeadingAzimuth === 'function'
            ? utils.formatPhotoHeadingAzimuth(deg)
            : '';
    const source =
        photo.exifData && photo.exifData.gpsHeadingSource != null
            ? String(photo.exifData.gpsHeadingSource)
            : photo.metadata && photo.metadata.gpsHeadingSource != null
              ? String(photo.metadata.gpsHeadingSource)
              : '';
    return {
        heading_degrees: deg != null ? String(deg) : '',
        heading_azimuth: az,
        heading_source: source,
    };
}

function photoExportAccuracyField(photo) {
    const utils = window.photoCanvasUtils;
    const meters =
        utils && typeof utils.getPhotoGpsAccuracyMeters === 'function'
            ? utils.getPhotoGpsAccuracyMeters(photo)
            : null;
    return meters != null ? String(meters) : '';
}

function photoSidecarRow(photo, zipPath) {
    const lat = Number(photo?.latlng?.lat);
    const lng = Number(photo?.latlng?.lng);
    const tagMod = window.photoTagsModule;
    const tags = tagMod && typeof tagMod.getPhotoTags === 'function' ? tagMod.getPhotoTags(photo) : [];
    const heading = photoExportHeadingFields(photo);
    return {
        filename: zipPath || '',
        name: photo.fileName || '',
        latitude: Number.isFinite(lat) ? lat.toFixed(6) : '',
        longitude: Number.isFinite(lng) ? lng.toFixed(6) : '',
        note: photo.note && String(photo.note).trim() ? String(photo.note).trim() : '',
        tags: tags.length ? tags.join(', ') : '',
        batch: getPhotoBatchDisplayName(photo),
        created_at: photo.createdAt || '',
        uploaded_by: photo.uploadedBy || '',
        gps_source: photo.exifData?.gpsSource || (photoHasGps(photo) ? 'EXIF' : 'None'),
        heading_degrees: heading.heading_degrees,
        heading_azimuth: heading.heading_azimuth,
        heading_source: heading.heading_source,
        gps_accuracy_meters: photoExportAccuracyField(photo),
    };
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Prevent note text from terminating a KML CDATA section. */
function sanitizeCdata(text) {
    return String(text || '').replace(/]]>/g, ']] >');
}

function photoDescriptionParts(photo) {
    const parts = [];
    if (photo.note && String(photo.note).trim()) parts.push(String(photo.note).trim());
    const tagMod = window.photoTagsModule;
    const tags = tagMod && typeof tagMod.getPhotoTags === 'function' ? tagMod.getPhotoTags(photo) : [];
    if (tags.length) parts.push(`Tags: ${tags.join(', ')}`);
    const batch = getPhotoBatchDisplayName(photo);
    if (batch) parts.push(`Batch: ${batch}`);
    const heading = photoExportHeadingFields(photo);
    if (heading.heading_azimuth) parts.push(`Facing: ${heading.heading_azimuth}`);
    const acc = photoExportAccuracyField(photo);
    if (acc) parts.push(`GPS accuracy: ±${acc} m`);
    return parts;
}

function photoKmlExtendedData(row) {
    const fields = [
        'filename',
        'name',
        'latitude',
        'longitude',
        'heading_degrees',
        'heading_azimuth',
        'heading_source',
        'gps_accuracy_meters',
        'gps_source',
        'batch',
        'created_at',
        'uploaded_by',
    ];
    let xml = '    <ExtendedData>\n';
    fields.forEach((key) => {
        const val = row[key] != null ? String(row[key]) : '';
        xml += `      <Data name="${escapeXml(key)}"><value>${escapeXml(val)}</value></Data>\n`;
    });
    xml += '    </ExtendedData>\n';
    return xml;
}

function photoToFeature(photo, zipPath) {
    if (!photoHasGps(photo)) return null;
    const lat = Number(photo.latlng.lat);
    const lng = Number(photo.latlng.lng);
    const descParts = photoDescriptionParts(photo);
    const row = photoSidecarRow(photo, zipPath);
    return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lng, lat] },
        properties: {
            name: zipPath || photo.fileName || '',
            note: descParts.join('\n'),
            filename: row.filename,
            displayName: row.name,
            batch: row.batch,
            createdAt: row.created_at,
            uploadedBy: row.uploaded_by,
            gpsSource: row.gps_source,
            tags: row.tags,
            headingDegrees: row.heading_degrees,
            headingAzimuth: row.heading_azimuth,
            headingSource: row.heading_source,
            gpsAccuracyMeters: row.gps_accuracy_meters,
        }
    };
}

/**
 * Photo KML with relative links so Google Earth can open co-located images.
 * @param {object[]} photos
 * @param {Map} pathByPhotoId
 * @returns {string}
 */
function buildPhotosKml(photos, pathByPhotoId) {
    let kml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    kml += '<kml xmlns="http://www.opengis.net/kml/2.2">\n';
    kml += '<Document>\n';

    for (const photo of photos) {
        if (!photoHasGps(photo)) continue;
        const lat = Number(photo.latlng.lat);
        const lng = Number(photo.latlng.lng);
        const zipPath = pathByPhotoId.get(photo.id) || '';
        const href = String(zipPath || '').replace(/\\/g, '/');
        if (!href) continue;

        const displayName = photo.fileName || href.split('/').pop() || 'Photo';
        const row = photoSidecarRow(photo, zipPath);
        const descParts = photoDescriptionParts(photo);
        const htmlParts = descParts.map((part) => escapeHtml(part).replace(/\n/g, '<br/>'));
        htmlParts.push(
            `<a href="${escapeHtml(href)}">Open photo</a><br/><img src="${escapeHtml(href)}" width="400"/>`
        );
        const descriptionHtml = sanitizeCdata(htmlParts.join('<br/>'));

        kml += '  <Placemark>\n';
        kml += `    <name>${escapeXml(displayName)}</name>\n`;
        kml += `    <description><![CDATA[${descriptionHtml}]]></description>\n`;
        kml += photoKmlExtendedData(row);
        kml += '    <Point>\n';
        kml += `      <coordinates>${lng},${lat}</coordinates>\n`;
        kml += '    </Point>\n';
        kml += '  </Placemark>\n';
    }

    kml += '</Document>\n';
    kml += '</kml>\n';
    return kml;
}

function buildPhotosCsv(photos, pathByPhotoId) {
    const headers = [
        'filename',
        'name',
        'latitude',
        'longitude',
        'note',
        'tags',
        'batch',
        'created_at',
        'uploaded_by',
        'gps_source',
        'heading_degrees',
        'heading_azimuth',
        'heading_source',
        'gps_accuracy_meters',
    ];
    const rows = [headers.join(',')];
    for (const photo of photos) {
        const row = photoSidecarRow(photo, pathByPhotoId.get(photo.id) || '');
        rows.push([
            escapeCsv(row.filename),
            escapeCsv(row.name),
            row.latitude,
            row.longitude,
            escapeCsv(row.note),
            escapeCsv(row.tags),
            escapeCsv(row.batch),
            escapeCsv(row.created_at),
            escapeCsv(row.uploaded_by),
            escapeCsv(row.gps_source),
            escapeCsv(row.heading_degrees),
            escapeCsv(row.heading_azimuth),
            escapeCsv(row.heading_source),
            escapeCsv(row.gps_accuracy_meters),
        ].join(','));
    }
    return rows.join('\n');
}

function buildPhotoSidecarBlob(photos, format, pathByPhotoId) {
    if (!format || format === 'none') {
        return { blob: null, filename: null, skippedNoGps: false, archiveKind: 'zip' };
    }

    if (format === 'csv') {
        const csv = buildPhotosCsv(photos, pathByPhotoId);
        return {
            blob: new Blob([csv], { type: 'text/csv' }),
            filename: 'metadata.csv',
            skippedNoGps: false,
            archiveKind: 'zip'
        };
    }

    const features = photos
        .map(photo => photoToFeature(photo, pathByPhotoId.get(photo.id) || ''))
        .filter(Boolean);
    if (features.length === 0) {
        return { blob: null, filename: null, skippedNoGps: true, archiveKind: format === 'kmz' ? 'kmz' : 'zip' };
    }

    const geojson = { type: 'FeatureCollection', features };
    if (format === 'geojson') {
        return {
            blob: new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/geo+json' }),
            filename: 'metadata.geojson',
            skippedNoGps: false,
            archiveKind: 'zip'
        };
    }
    if (format === 'kml') {
        const kml = buildPhotosKml(photos, pathByPhotoId);
        return {
            blob: new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }),
            filename: 'metadata.kml',
            skippedNoGps: false,
            archiveKind: 'zip'
        };
    }
    if (format === 'kmz') {
        const kml = buildPhotosKml(photos, pathByPhotoId);
        return {
            blob: new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }),
            filename: 'doc.kml',
            skippedNoGps: false,
            archiveKind: 'kmz'
        };
    }

    throw new Error('Unsupported metadata format: ' + format);
}

function checkPhotoExportLimits(photos) {
    if (photos.length > PHOTO_EXPORT_MAX_COUNT) {
        throw new Error(
            (typeof t === 'function'
                ? t('You can export up to {max} photos at a time. You selected {count}.\n\nPlease select fewer photos and try again.', {
                    max: PHOTO_EXPORT_MAX_COUNT,
                    count: photos.length
                })
                : `You can export up to ${PHOTO_EXPORT_MAX_COUNT} photos at a time. You selected ${photos.length}.\n\nPlease select fewer photos and try again.`)
        );
    }
    const estimated = photos.reduce((sum, photo) => sum + (photo.fileSize || 0), 0);
    if (estimated > PHOTO_EXPORT_MAX_SIZE) {
        const sizeMB = (estimated / (1024 * 1024)).toFixed(2);
        const limitMB = (PHOTO_EXPORT_MAX_SIZE / (1024 * 1024)).toFixed(0);
        throw new Error(
            (typeof t === 'function'
                ? t('Export file size ({sizeMB} MB) exceeds the {limitMB} MB limit.\n\nPlease select fewer items or contact us for assistance with larger exports.', { sizeMB, limitMB })
                : `Export file size (${sizeMB} MB) exceeds the ${limitMB} MB limit.\n\nPlease select fewer items or contact us for assistance with larger exports.`)
        );
    }
}

async function runWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function runWorker() {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await worker(items[index], index);
        }
    }

    const workers = [];
    const n = Math.min(limit, items.length);
    for (let i = 0; i < n; i += 1) {
        workers.push(runWorker());
    }
    await Promise.all(workers);
    return results;
}

function showPhotoExportProgress(state) {
    const overlay = document.getElementById('photoExportProgressOverlay');
    const titleEl = document.getElementById('photoExportProgressTitle');
    const textEl = document.getElementById('photoExportProgressText');
    const barFill = document.getElementById('photoExportProgressBarFill');
    const barTrack = document.getElementById('photoExportProgressBarTrack');
    if (!overlay) return;

    const phase = state?.phase || 'download';
    let percent = 0;
    let title = typeof t === 'function' ? t('Processing export') : 'Processing export';
    let statusText = '';

    if (phase === 'zip') {
        percent = Math.min(100, Math.max(0, Math.round(state?.percent || 0)));
        statusText = typeof t === 'function'
            ? t('Creating ZIP file… {percent}%', { percent })
            : `Creating ZIP file… ${percent}%`;
    } else {
        const current = state?.current || 0;
        const total = state?.total || 0;
        percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
        statusText = typeof t === 'function'
            ? t('Downloading images… {current} of {total}', { current, total })
            : `Downloading images… ${current} of ${total}`;
    }

    overlay.style.display = 'flex';
    overlay.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    if (titleEl) titleEl.textContent = title;
    if (textEl) textEl.textContent = statusText;
    if (barFill) barFill.style.width = `${percent}%`;
    if (barTrack) barTrack.setAttribute('aria-valuenow', String(percent));
}

function hidePhotoExportProgress() {
    const overlay = document.getElementById('photoExportProgressOverlay');
    if (!overlay) return;
    overlay.style.display = 'none';
    overlay.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
}

async function runPhotoExportWithOptions(options) {
    const photos = getSelectedPhotos();
    checkPhotoExportLimits(photos);

    if (typeof JSZip === 'undefined') {
        throw new Error(typeof t === 'function'
            ? t('ZIP library not loaded. Please refresh the page.')
            : 'ZIP library not loaded. Please refresh the page.');
    }

    const forceJpegExt = !!(options.stampPhotos || options.embedGps);
    const pathByPhotoId = buildPhotoZipPaths(photos, options.layout || 'flat', forceJpegExt);
    const exportedEntries = [];
    let failedCount = 0;
    let embedSkippedCount = 0;
    let completedCount = 0;
    let firstExportError = null;

    showPhotoExportProgress({ phase: 'download', current: 0, total: photos.length });

    const photosModule = window.photosModule;
    if (!photosModule?.blobFromPhotoForExport) {
        hidePhotoExportProgress();
        throw new Error(typeof t === 'function'
            ? t('Photo export helpers not loaded. Please refresh the page.')
            : 'Photo export helpers not loaded. Please refresh the page.');
    }

    const embedGpsFn = window.photoExifWrite?.embedGpsInJpegBlob || window.__embedGpsInJpegBlob;
    if (options.embedGps && typeof embedGpsFn !== 'function') {
        hidePhotoExportProgress();
        throw new Error(typeof t === 'function'
            ? t('GPS embed helper not loaded. Please refresh the page.')
            : 'GPS embed helper not loaded. Please refresh the page.');
    }

    try {
        await runWithConcurrency(photos, PHOTO_EXPORT_CONCURRENCY, async (photo) => {
            try {
                let blob = await photosModule.blobFromPhotoForExport(photo);
                if (options.stampPhotos && window.photoCanvasUtils?.stampPhotoWithGpsAndDate) {
                    blob = await window.photoCanvasUtils.stampPhotoWithGpsAndDate(blob, photo, {
                        position: options.stampPosition
                    });
                }
                if (options.embedGps && photoHasGps(photo)) {
                    try {
                        const utils = window.photoCanvasUtils;
                        const embedOpts = {};
                        if (utils && typeof utils.photoHasHeading === 'function' && utils.photoHasHeading(photo)) {
                            const headingDeg =
                                typeof utils.getPhotoHeadingDegrees === 'function'
                                    ? utils.getPhotoHeadingDegrees(photo)
                                    : null;
                            if (headingDeg != null) embedOpts.headingDegrees = headingDeg;
                        }
                        if (utils && typeof utils.getPhotoGpsAccuracyMeters === 'function') {
                            const acc = utils.getPhotoGpsAccuracyMeters(photo);
                            if (acc != null) embedOpts.accuracyMeters = acc;
                        }
                        blob = await embedGpsFn(
                            blob,
                            Number(photo.latlng.lat),
                            Number(photo.latlng.lng),
                            embedOpts
                        );
                    } catch (embedError) {
                        embedSkippedCount += 1;
                        console.warn('Embed GPS failed for photo:', photo.id, embedError);
                    }
                } else if (options.embedGps && !photoHasGps(photo)) {
                    embedSkippedCount += 1;
                }
                exportedEntries.push({
                    photo,
                    path: pathByPhotoId.get(photo.id),
                    blob
                });
            } catch (error) {
                failedCount += 1;
                if (!firstExportError) firstExportError = error;
                console.error('Photo export failed:', photo.id, error);
            } finally {
                completedCount += 1;
                showPhotoExportProgress({ phase: 'download', current: completedCount, total: photos.length });
            }
        });

        if (exportedEntries.length === 0) {
            const detail = firstExportError?.message ? `\n\n${firstExportError.message}` : '';
            throw new Error(
                (typeof t === 'function'
                    ? t('No photos could be exported.')
                    : 'No photos could be exported.') + detail
            );
        }

        const exportedPhotos = exportedEntries.map(entry => entry.photo);
        const sidecar = buildPhotoSidecarBlob(exportedPhotos, options.metadataFormat, pathByPhotoId);

        const zip = new JSZip();
        for (const entry of exportedEntries) {
            zip.file(entry.path, entry.blob);
        }
        if (sidecar.blob && sidecar.filename) {
            zip.file(sidecar.filename, sidecar.blob);
        }

        const isKmz = sidecar.archiveKind === 'kmz' && !!(sidecar.blob && sidecar.filename);
        const archiveName = isKmz
            ? `photos-${getExportDateSuffix()}.kmz`
            : `photos-${getExportDateSuffix()}.zip`;
        const mimeType = isKmz
            ? 'application/vnd.google-earth.kmz'
            : 'application/zip';

        showPhotoExportProgress({ phase: 'zip', percent: 0 });
        const content = await zip.generateAsync({ type: 'blob' }, (metadata) => {
            showPhotoExportProgress({ phase: 'zip', percent: metadata.percent });
        });
        checkExportSize([{ blob: content }], PHOTO_EXPORT_MAX_SIZE);
        downloadBlob(content, archiveName, mimeType);

        const messages = [];
        if (failedCount > 0) {
            messages.push(typeof t === 'function'
                ? t('Exported {ok} of {total} photos; {failed} failed.', {
                    ok: exportedEntries.length,
                    total: photos.length,
                    failed: failedCount
                })
                : `Exported ${exportedEntries.length} of ${photos.length} photos; ${failedCount} failed.`);
        }
        if (sidecar.skippedNoGps) {
            messages.push(typeof t === 'function'
                ? t('Photos exported; no GPS locations to include in metadata file.')
                : 'Photos exported; no GPS locations to include in metadata file.');
        }
        if (options.embedGps && embedSkippedCount > 0 && failedCount === 0) {
            messages.push(typeof t === 'function'
                ? t('GPS was not embedded in {count} photo(s) (no location or write failed).', {
                    count: embedSkippedCount
                })
                : `GPS was not embedded in ${embedSkippedCount} photo(s) (no location or write failed).`);
        }
        if (messages.length > 0) {
            void appAlert(messages.join('\n\n'));
        }
    } finally {
        hidePhotoExportProgress();
    }
}

function getSelectedExportItems(currentView) {
    const selectedDataIds = window.dataSelectionModule?.selectedDataIds || new Set();

    if (currentView === 'annotations') {
        const annotations = window.annotationStorageModule?.annotations || [];
        const selectedAnnotations = annotations.filter(a => selectedDataIds.has(a.id));
        if (selectedAnnotations.length === 0) {
            throw new Error(typeof t === 'function' ? t('No annotations selected.') : 'No annotations selected.');
        }
        return {
            fileMode: 'single',
            units: [{
                baseName: `annotations-${getExportDateSuffix()}`,
                geojson: buildFeatureCollectionFromAnnotations(selectedAnnotations)
            }],
            archiveName: `annotations-${getExportDateSuffix()}.zip`
        };
    }

    if (currentView === 'layers') {
        const savedLayers = window.annotationStorageModule?.savedDataLayers || [];
        const selectedLayers = savedLayers.filter(l => selectedDataIds.has(l.id));
        if (selectedLayers.length === 0) {
            throw new Error(typeof t === 'function' ? t('No data layers selected.') : 'No data layers selected.');
        }
        return {
            selectedLayers,
            archiveName: `data-layers-${getExportDateSuffix()}.zip`
        };
    }

    if (currentView === 'photos') {
        return { photos: getSelectedPhotos() };
    }

    throw new Error(typeof t === 'function'
        ? t('Export is only available for annotations, data layers, and photos.')
        : 'Export is only available for annotations, data layers, and photos.');
}

async function runExportWithOptions(options) {
    const currentView = window.dataWindowModule?.currentDataView;

    if (currentView === 'photos') {
        await runPhotoExportWithOptions(options);
        return;
    }

    const selection = getSelectedExportItems(currentView);
    const fileMode = currentView === 'layers' ? options.fileMode : 'single';
    const outputs = [];

    if (currentView === 'annotations') {
        for (const unit of selection.units) {
            const geojson = maybeReprojectGeoJSON(unit.geojson, options);
            outputs.push(...convertUnitToOutputs(geojson, options.format, unit.baseName));
        }
        await deliverExportOutputs(outputs, selection.archiveName);
        return;
    }

    const units = buildExportUnitsFromLayers(selection.selectedLayers, fileMode);
    if (units.length === 0) {
        throw new Error(typeof t === 'function' ? t('No exportable data found.') : 'No exportable data found.');
    }

    for (const unit of units) {
        const geojson = maybeReprojectGeoJSON(unit.geojson, options);
        outputs.push(...convertUnitToOutputs(geojson, options.format, unit.baseName));
    }

    await deliverExportOutputs(outputs, selection.archiveName);
}

function setExportModalSectionsForView(currentView) {
    const geoOptions = document.getElementById('exportGeoOptions');
    const photoOptions = document.getElementById('exportPhotoOptions');
    const titleEl = document.getElementById('exportOptionsModalTitle');

    const isPhotos = currentView === 'photos';
    if (geoOptions) geoOptions.style.display = isPhotos ? 'none' : 'block';
    if (photoOptions) photoOptions.style.display = isPhotos ? 'block' : 'none';
    if (titleEl) {
        titleEl.textContent = isPhotos
            ? (typeof t === 'function' ? t('Export Photos') : 'Export Photos')
            : (typeof t === 'function' ? t('Export Options') : 'Export Options');
    }

    if (isPhotos) {
        const layoutSelect = document.getElementById('exportPhotoLayoutSelect');
        const stampCheckbox = document.getElementById('exportPhotoStampEnabled');
        const stampPositionSelect = document.getElementById('exportPhotoStampPositionSelect');
        const embedGpsCheckbox = document.getElementById('exportPhotoEmbedGps');
        const metadataSelect = document.getElementById('exportPhotoMetadataSelect');
        const savedPosition = window.photoCanvasUtils?.getSavedPhotoStampPosition
            ? window.photoCanvasUtils.getSavedPhotoStampPosition()
            : 'bottom';
        if (layoutSelect) layoutSelect.value = 'flat';
        if (stampCheckbox) stampCheckbox.checked = false;
        if (embedGpsCheckbox) embedGpsCheckbox.checked = false;
        if (stampPositionSelect) stampPositionSelect.value = savedPosition;
        if (metadataSelect) metadataSelect.value = 'csv';
        updatePhotoStampPositionVisibility();
        updatePhotoMetadataFormatHint();
    }
}

function updatePhotoStampPositionVisibility() {
    const enabled = document.getElementById('exportPhotoStampEnabled')?.checked;
    const group = document.getElementById('exportPhotoStampPositionGroup');
    if (group) group.style.display = enabled ? 'block' : 'none';
}

function updatePhotoMetadataFormatHint() {
    const format = document.getElementById('exportPhotoMetadataSelect')?.value || '';
    const hint = document.getElementById('exportPhotoMetadataHint');
    if (!hint) return;
    if (format === 'kml') {
        hint.style.display = 'block';
        hint.textContent = typeof t === 'function'
            ? t('Extract the ZIP so the KML and photos are in the same folder, then open the KML in Google Earth.')
            : 'Extract the ZIP so the KML and photos are in the same folder, then open the KML in Google Earth.';
    } else if (format === 'kmz') {
        hint.style.display = 'block';
        hint.textContent = typeof t === 'function'
            ? t('Open the KMZ directly in Google Earth; photos are packed inside.')
            : 'Open the KMZ directly in Google Earth; photos are packed inside.';
    } else {
        hint.style.display = 'none';
        hint.textContent = '';
    }
}

function openExportOptionsModal() {
    const selectedDataIds = window.dataSelectionModule?.selectedDataIds || new Set();
    if (selectedDataIds.size === 0) {
        void appAlert(typeof t === 'function' ? t('No items selected.') : 'No items selected.');
        return;
    }

    const currentView = window.dataWindowModule?.currentDataView;
    if (currentView !== 'annotations' && currentView !== 'layers' && currentView !== 'photos') {
        void appAlert(typeof t === 'function'
            ? t('Export is only available for annotations, data layers, and photos.')
            : 'Export is only available for annotations, data layers, and photos.');
        return;
    }

    if (currentView === 'photos') {
        try {
            checkPhotoExportLimits(getSelectedPhotos());
        } catch (error) {
            void appAlert(error?.message || String(error));
            return;
        }
    }

    const overlay = document.getElementById('exportOptionsModal');
    const formatSelect = document.getElementById('exportFormatSelect');
    const fileModeGroup = document.getElementById('exportFileModeGroup');
    const advancedSettings = document.getElementById('exportAdvancedSettings');
    const reprojectEnabled = document.getElementById('exportReprojectEnabled');
    const targetEpsg = document.getElementById('exportTargetEpsg');

    setExportModalSectionsForView(currentView);

    if (formatSelect) formatSelect.value = 'geojson';
    if (advancedSettings) advancedSettings.open = false;
    if (reprojectEnabled) reprojectEnabled.checked = false;
    if (targetEpsg) targetEpsg.value = '';

    if (fileModeGroup) {
        fileModeGroup.style.display = currentView === 'layers' ? 'block' : 'none';
    }

    const individualRadio = document.querySelector('input[name="exportFileMode"][value="individual"]');
    if (individualRadio) individualRadio.checked = true;

    updateExportReprojectInputState();

    if (overlay) {
        overlay.style.display = 'flex';
        overlay.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        if (window.appI18n && window.appI18n.localizeTree) {
            window.appI18n.localizeTree(overlay);
        }
    }
}

function closeExportOptionsModal() {
    const overlay = document.getElementById('exportOptionsModal');
    if (overlay) {
        overlay.style.display = 'none';
        overlay.setAttribute('aria-hidden', 'true');
    }
    document.body.style.overflow = '';
}

function updateExportReprojectInputState() {
    const enabled = document.getElementById('exportReprojectEnabled')?.checked;
    const input = document.getElementById('exportTargetEpsg');
    if (input) input.disabled = !enabled;
}

async function confirmExportWithOptions() {
    const currentView = window.dataWindowModule?.currentDataView;

    try {
        if (currentView === 'photos') {
            closeExportOptionsModal();
            const stampPhotos = document.getElementById('exportPhotoStampEnabled')?.checked || false;
            const stampPosition = document.getElementById('exportPhotoStampPositionSelect')?.value || 'bottom';
            if (stampPhotos && window.photoCanvasUtils?.savePhotoStampPosition) {
                window.photoCanvasUtils.savePhotoStampPosition(stampPosition);
            }
            await runPhotoExportWithOptions({
                layout: document.getElementById('exportPhotoLayoutSelect')?.value || 'flat',
                stampPhotos,
                stampPosition,
                embedGps: document.getElementById('exportPhotoEmbedGps')?.checked || false,
                metadataFormat: document.getElementById('exportPhotoMetadataSelect')?.value || 'csv'
            });
            return;
        }

        const format = document.getElementById('exportFormatSelect')?.value || 'geojson';
        const fileMode = currentView === 'layers'
            ? (document.querySelector('input[name="exportFileMode"]:checked')?.value || 'individual')
            : 'single';
        const reproject = document.getElementById('exportReprojectEnabled')?.checked || false;
        const targetEpsg = normalizeEpsgCode(document.getElementById('exportTargetEpsg')?.value || '');

        if (reproject && !validateEpsgCode(targetEpsg)) {
            void appAlert(typeof t === 'function'
                ? t('Invalid EPSG code. Please enter a valid code like EPSG:3857.')
                : 'Invalid EPSG code. Please enter a valid code like EPSG:3857.');
            return;
        }

        closeExportOptionsModal();

        await runExportWithOptions({
            format,
            fileMode,
            reproject,
            targetEpsg
        });
    } catch (error) {
        hidePhotoExportProgress();
        console.error('Export error:', error);
        void appAlert(error.message || (typeof t === 'function'
            ? t('Error creating export file. Please try again.')
            : 'Error creating export file. Please try again.'));
    }
}

function bulkExportSelected() {
    openExportOptionsModal();
}

// Convert GeoJSON to KML (simplified version)
function convertGeoJSONToKML(geojson) {
    let kml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    kml += '<kml xmlns="http://www.opengis.net/kml/2.2">\n';
    kml += '<Document>\n';

    if (geojson.features) {
        geojson.features.forEach((feature, index) => {
            const name = feature.properties?.name || `Feature ${index + 1}`;
            const description = feature.properties?.note || '';

            if (feature.geometry.type === 'Point') {
                const [lng, lat] = feature.geometry.coordinates;
                kml += `  <Placemark>\n`;
                kml += `    <name>${escapeXml(name)}</name>\n`;
                if (description) {
                    kml += `    <description>${escapeXml(description)}</description>\n`;
                }
                kml += `    <Point>\n`;
                kml += `      <coordinates>${lng},${lat}</coordinates>\n`;
                kml += `    </Point>\n`;
                kml += `  </Placemark>\n`;
            } else if (feature.geometry.type === 'LineString') {
                const coords = feature.geometry.coordinates.map(c => `${c[0]},${c[1]}`).join(' ');
                kml += `  <Placemark>\n`;
                kml += `    <name>${escapeXml(name)}</name>\n`;
                if (description) {
                    kml += `    <description>${escapeXml(description)}</description>\n`;
                }
                kml += `    <LineString>\n`;
                kml += `      <coordinates>${coords}</coordinates>\n`;
                kml += `    </LineString>\n`;
                kml += `  </Placemark>\n`;
            } else if (feature.geometry.type === 'Polygon') {
                const coords = feature.geometry.coordinates[0].map(c => `${c[0]},${c[1]}`).join(' ');
                kml += `  <Placemark>\n`;
                kml += `    <name>${escapeXml(name)}</name>\n`;
                if (description) {
                    kml += `    <description>${escapeXml(description)}</description>\n`;
                }
                kml += `    <Polygon>\n`;
                kml += `      <outerBoundaryIs>\n`;
                kml += `        <LinearRing>\n`;
                kml += `          <coordinates>${coords}</coordinates>\n`;
                kml += `        </LinearRing>\n`;
                kml += `      </outerBoundaryIs>\n`;
                kml += `    </Polygon>\n`;
                kml += `  </Placemark>\n`;
            }
        });
    }

    kml += '</Document>\n';
    kml += '</kml>\n';

    return kml;
}

function escapeXml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function downloadBlob(blob, filename, mimeType) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

window.dataExportModule = {
    bulkExportSelected,
    openExportOptionsModal,
    closeExportOptionsModal,
    confirmExportWithOptions,
    updateExportReprojectInputState,
    updatePhotoStampPositionVisibility,
    updatePhotoMetadataFormatHint,
    runExportWithOptions,
    runPhotoExportWithOptions,
    convertGeoJSONToKML,
    downloadBlob
};

window.bulkExportSelected = bulkExportSelected;
window.openExportOptionsModal = openExportOptionsModal;
window.closeExportOptionsModal = closeExportOptionsModal;
window.confirmExportWithOptions = confirmExportWithOptions;
window.updateExportReprojectInputState = updateExportReprojectInputState;
window.updatePhotoStampPositionVisibility = updatePhotoStampPositionVisibility;
window.updatePhotoMetadataFormatHint = updatePhotoMetadataFormatHint;
