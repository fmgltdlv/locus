
// Initialize - load saved photos
loadSavedPhotos();

// Photo viewer state
let photoViewerZoom = 1;
let photoViewerPanX = 0;
let photoViewerPanY = 0;
let photoViewerIsDragging = false;
let photoViewerDragStart = { x: 0, y: 0 };
/** @type {{ items: object[], index: number } | null} */
let photoViewerGallery = null;
let photoViewerCompareActive = false;
let photoViewerComparePosition = 50;
let photoViewerCompareRefLoadable = false;
let photoViewerCompareCheckToken = 0;
let photoViewerCompareBound = false;
let photoViewerCompareDragToken = 0;
/** @type {object|null} */
let photoViewerCurrentPhoto = null;

// Check if device is mobile
function isMobileDevice() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || 
           (window.innerWidth <= 768);
}

var PHOTO_GALLERY_MAX_CONCURRENT_UPLOADS_MOBILE = 2;
var PHOTO_GALLERY_MAX_CONCURRENT_UPLOADS_DESKTOP = 4;

function getPhotoGalleryMaxConcurrentUploads() {
    return isMobileDevice() ? PHOTO_GALLERY_MAX_CONCURRENT_UPLOADS_MOBILE : PHOTO_GALLERY_MAX_CONCURRENT_UPLOADS_DESKTOP;
}

function photoCanvas() {
    return window.photoCanvasUtils;
}

function isHeicOrHeifFile(file) {
    if (!file) return false;
    const type = (file.type || '').toLowerCase();
    if (type === 'image/heic' || type === 'image/heif' || type === 'image/heic-sequence' || type === 'image/heif-sequence') {
        return true;
    }
    return /\.(heic|heif)$/i.test(file.name || '');
}

function emptyPhotoExifData() {
    return {
        dateTime: null,
        make: null,
        model: null,
        orientation: null,
        hasGPS: false,
        gpsLat: null,
        gpsLng: null,
        gpsSource: 'None',
    };
}

/** Snapshot EXIF read from the original file before HEIC conversion or resize strips it. */
function buildPhotoUploadManifest(file, gps, exifData, exifTags, exifReadOk) {
    return {
        originalFileName: file && file.name ? String(file.name) : 'photo',
        originalMimeType: file && file.type ? String(file.type) : '',
        originalSize: file && file.size ? Number(file.size) : 0,
        sourceFormat: isHeicOrHeifFile(file) ? 'heic' : 'other',
        readAt: new Date().toISOString(),
        exifReadOk: !!exifReadOk,
        exifData: Object.assign(emptyPhotoExifData(), exifData || {}),
        exifTags: exifTags || null,
    };
}

function serializeExifTagsForManifest(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    const keys = [
        'Make',
        'Model',
        'DateTimeOriginal',
        'CreateDate',
        'ModifyDate',
        'DateTime',
        'Orientation',
        'ISO',
        'ISOSpeedRatings',
        'FNumber',
        'ExposureTime',
        'FocalLength',
        'LensModel',
        'latitude',
        'longitude',
        'GPSAltitude',
    ];
    keys.forEach(function (key) {
        if (raw[key] == null) return;
        const value = raw[key];
        if (value instanceof Date) out[key] = value.toISOString();
        else if (typeof value === 'object') return;
        else out[key] = value;
    });
    return Object.keys(out).length ? out : null;
}

function mergePhotoUploadExif(primary, fallback) {
    const a = primary && typeof primary === 'object' ? primary : {};
    const b = fallback && typeof fallback === 'object' ? fallback : {};
    const merged = Object.assign({}, b, a);
    const primaryHasGps =
        a.hasGPS === true &&
        Number.isFinite(Number(a.gpsLat)) &&
        Number.isFinite(Number(a.gpsLng)) &&
        a.gpsSource !== 'None';
    const fallbackHasGps =
        b.hasGPS === true &&
        Number.isFinite(Number(b.gpsLat)) &&
        Number.isFinite(Number(b.gpsLng)) &&
        b.gpsSource !== 'None';
    if (!primaryHasGps && fallbackHasGps) {
        merged.hasGPS = true;
        merged.gpsLat = b.gpsLat;
        merged.gpsLng = b.gpsLng;
        merged.gpsSource = b.gpsSource;
    }
    return merged;
}

function resolveUploadLatlngFromExif(latlng, exifData) {
    if (latlng && Number.isFinite(Number(latlng.lat)) && Number.isFinite(Number(latlng.lng))) {
        return latlng;
    }
    if (
        exifData &&
        exifData.hasGPS &&
        Number.isFinite(Number(exifData.gpsLat)) &&
        Number.isFinite(Number(exifData.gpsLng))
    ) {
        return L.latLng(Number(exifData.gpsLat), Number(exifData.gpsLng));
    }
    return null;
}

function syncUploadManifestExif(manifest, exifData) {
    if (!manifest || !exifData) return;
    manifest.exifData = Object.assign(emptyPhotoExifData(), exifData);
}

function latlngFromPhotoUploadItem(item) {
    const gps = item && item.gps;
    if (gps && Number.isFinite(gps.lat) && Number.isFinite(gps.lng)) {
        return L.latLng(gps.lat, gps.lng);
    }
    return null;
}

/** Merge manifest EXIF/GPS from pick time; used before convert/upload. */
function resolvePhotoUploadFields(item) {
    const file = item && item.file;
    const uploadManifest = item && item.uploadManifest ? item.uploadManifest : null;
    let exifData = item && item.exifData ? item.exifData : emptyPhotoExifData();
    let latlng = latlngFromPhotoUploadItem(item);
    exifData = mergePhotoUploadExif(exifData, uploadManifest && uploadManifest.exifData);
    latlng = resolveUploadLatlngFromExif(latlng, exifData);
    if (latlng && exifData) {
        exifData.hasGPS = true;
        exifData.gpsLat = latlng.lat;
        exifData.gpsLng = latlng.lng;
        if (!exifData.gpsSource || exifData.gpsSource === 'None') {
            exifData.gpsSource = 'EXIF';
        }
    }
    return {
        file: file,
        originalFileName: file && file.name ? file.name : 'photo',
        latlng: latlng,
        exifData: exifData,
        uploadManifest: uploadManifest,
    };
}

/** Convert (HEIC) and resize one photo. Does not upload. Date/GPS stay as metadata (viewer overlay / optional export stamp). */
async function preparePhotoUploadBundle(item) {
    const ctx = resolvePhotoUploadFields(item);
    if (!ctx.file) return null;
    let file = await shrinkPhotoFileForUpload(ctx.file);
    if (!file) return null;
    return {
        file: file,
        originalFileName: ctx.originalFileName,
        latlng: ctx.latlng,
        exifData: ctx.exifData,
        uploadManifest: ctx.uploadManifest,
    };
}

/**
 * Gallery batch: prepare the next photo while up to N uploads run concurrently
 * (2 mobile, 4 desktop). Prepared queue is capped at N to limit memory.
 */
async function runGalleryPhotoUploadPipeline(items) {
    if (!items || !items.length) {
        return { uploadedOk: 0, uploadedNoGps: 0 };
    }
    const maxConcurrent = getPhotoGalleryMaxConcurrentUploads();
    const total = items.length;
    const preparedQueue = [];
    let prepareIndex = 0;
    let prepareDone = false;
    let activeUploads = 0;
    let finishedUploads = 0;
    let uploadedOk = 0;
    let uploadedNoGps = 0;
    let prepareWaitResolve = null;
    let allDoneResolve = null;

    function notifyPrepareCanContinue() {
        if (prepareWaitResolve) {
            const resume = prepareWaitResolve;
            prepareWaitResolve = null;
            resume();
        }
    }

    function updatePipelineUploadStatus() {
        const current = Math.min(Math.max(finishedUploads + activeUploads, 1), total);
        showPhotoUploadStatus(total, current, finishedUploads);
    }

    function maybeFinishAll() {
        if (prepareDone && preparedQueue.length === 0 && activeUploads === 0 && allDoneResolve) {
            allDoneResolve({ uploadedOk: uploadedOk, uploadedNoGps: uploadedNoGps });
            allDoneResolve = null;
        }
    }

    function pumpUploads() {
        while (activeUploads < maxConcurrent && preparedQueue.length > 0) {
            const bundle = preparedQueue.shift();
            notifyPrepareCanContinue();
            activeUploads++;
            updatePipelineUploadStatus();
            uploadPreparedPhotoBundle(bundle, null, null, null)
                .then(function (ok) {
                    if (ok) {
                        uploadedOk++;
                        if (!bundle.latlng) uploadedNoGps++;
                    }
                })
                .finally(function () {
                    activeUploads--;
                    finishedUploads++;
                    updatePipelineUploadStatus();
                    pumpUploads();
                    maybeFinishAll();
                });
        }
        maybeFinishAll();
    }

    async function prepareAllItems() {
        while (prepareIndex < items.length) {
            while (preparedQueue.length >= maxConcurrent) {
                await new Promise(function (resolve) {
                    prepareWaitResolve = resolve;
                });
            }
            const bundle = await preparePhotoUploadBundle(items[prepareIndex]);
            prepareIndex++;
            if (bundle) {
                preparedQueue.push(bundle);
            }
            pumpUploads();
        }
        prepareDone = true;
        maybeFinishAll();
    }

    const uploadsDonePromise = new Promise(function (resolve) {
        allDoneResolve = resolve;
    });
    updatePipelineUploadStatus();
    void prepareAllItems();
    return uploadsDonePromise;
}

const HEIC_CONVERT_FAILED_MESSAGE =
    'This HEIC photo could not be converted. Try saving it as JPEG in your Photos app, or use the in-app camera.';
const HEIC_CONVERT_TIMEOUT_MS = 45000;

function withHeicConvertTimeout(promise) {
    return Promise.race([
        promise,
        new Promise(function (_, reject) {
            setTimeout(function () {
                reject(new Error('HEIC conversion timed out'));
            }, HEIC_CONVERT_TIMEOUT_MS);
        }),
    ]);
}

/**
 * Convert HEIC/HEIF to a JPEG File before upload. Browsers cannot display HEIC served
 * from storage, so raw HEIC must never be uploaded.
 * @returns {Promise<File|null>} JPEG File, or null (with user alert) when conversion fails.
 */
async function convertHeicFileToJpeg(file) {
    if (typeof window.__convertHeicToJpeg !== 'function') {
        await appAlert(HEIC_CONVERT_FAILED_MESSAGE);
        return null;
    }
    const batchTotal = photoHeicConvertBatchTotal;
    const completedBefore = photoHeicConvertBatchDone;
    const prevStatus = showPhotoUploadConverting(completedBefore, batchTotal, 'active');
    try {
        const jpegBlob = await withHeicConvertTimeout(window.__convertHeicToJpeg(file));
        if (!jpegBlob || !jpegBlob.size) throw new Error('Empty conversion result');
        markPhotoHeicConverted();
        if (batchTotal > 1) {
            showPhotoUploadConverting(photoHeicConvertBatchDone, batchTotal, 'done');
        }
        const baseName = (file.name && file.name.replace(/\.[^.]+$/, '')) || 'photo';
        return new File([jpegBlob], baseName + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
    } catch (e) {
        console.error('HEIC conversion failed:', e);
        const timedOut = e && e.message === 'HEIC conversion timed out';
        await appAlert(
            timedOut
                ? 'HEIC conversion is taking too long. Try saving the photo as JPEG in your Photos app, or use the in-app camera.'
                : HEIC_CONVERT_FAILED_MESSAGE
        );
        return null;
    } finally {
        restorePhotoUploadStatusAfterConverting(prevStatus);
    }
}

/**
 * Resize/re-encode photos client-side to stay within PHOTO_UPLOAD_MAX_BYTES and reasonable dimensions.
 * GPS/EXIF for tagging is already read earlier from the original file.
 * @returns {Promise<File|null>} JPEG File, original File if already within limits, or null on failure.
 */
async function shrinkPhotoFileForUpload(file) {
    if (!file || !file.size) {
        return null;
    }
    const maxBytes = PHOTO_UPLOAD_MAX_BYTES;
    const imageExt = /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i;
    const looksImage = (file.type && file.type.startsWith('image/')) || imageExt.test(file.name || '');
    if (!looksImage) {
        if (file.size > maxBytes) {
            await appAlert('File is too large. Photos must be ' + Math.round(maxBytes / (1024 * 1024)) + ' MB or smaller.');
            return null;
        }
        return file;
    }

    if (isHeicOrHeifFile(file)) {
        file = await convertHeicFileToJpeg(file);
        if (!file) return null;
    }

    let decoded = null;
    try {
        decoded = await photoCanvas().decodeImageForCanvas(file);
    } catch (_) {
        // Never fall back to uploading an undecodable original here: HEIC was already
        // converted above, so this is a genuinely unreadable image.
        await appAlert('Could not read this image. Try a JPEG or PNG under ' + Math.round(maxBytes / (1024 * 1024)) + ' MB.');
        return null;
    }

    const drawable = decoded.drawable;
    const isBitmap = decoded.isBitmap;
    const dim = photoCanvas().drawableWidthHeight(drawable, isBitmap);
    let w = dim.w;
    let h = dim.h;
    if (!w || !h) {
        if (isBitmap && drawable.close) drawable.close();
        if (file.size <= maxBytes) {
            return file;
        }
        await appAlert('Invalid image dimensions.');
        return null;
    }

    if (file.size <= maxBytes && Math.max(w, h) <= PHOTO_CLIENT_MAX_EDGE_PX_START) {
        if (isBitmap && drawable.close) drawable.close();
        return file;
    }

    const baseName = (file.name && file.name.replace(/\.[^.]+$/, '')) || 'photo';
    const outName = baseName + '.jpg';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        if (isBitmap && drawable.close) drawable.close();
        await appAlert('Could not process this image in this browser.');
        return null;
    }

    let maxEdge = PHOTO_CLIENT_MAX_EDGE_PX_START;
    let blob = null;

    while (maxEdge >= 640) {
        const scale = Math.min(1, maxEdge / Math.max(w, h));
        const tw = Math.max(1, Math.round(w * scale));
        const th = Math.max(1, Math.round(h * scale));
        canvas.width = tw;
        canvas.height = th;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(drawable, 0, 0, tw, th);

        let quality = 0.88;
        while (quality >= 0.5) {
            blob = await photoCanvas().canvasToJpegBlob(canvas, quality);
            if (blob && blob.size <= maxBytes) {
                if (isBitmap && drawable.close) drawable.close();
                return new File([blob], outName, { type: 'image/jpeg', lastModified: Date.now() });
            }
            quality -= 0.07;
        }
        maxEdge = Math.round(maxEdge * 0.82);
    }

    if (isBitmap && drawable.close) drawable.close();
    if (blob && blob.size <= maxBytes) {
        return new File([blob], outName, { type: 'image/jpeg', lastModified: Date.now() });
    }
    await appAlert('Photo is still too large after resizing. Try a different image.');
    return null;
}

function photoUploadAllowsMissingMap() {
    return !!(window.photoUploadAssociationContext && window.photoUploadAssociationContext.source === 'dirt');
}

function closeMobilePhotoSourceMenu() {
    /* retired — source modal removed; kept for API compat */
}

function cancelActiveMapModesForUpload() {
    if (window.annotationsModule && window.annotationsModule.cancelDrawingMode) {
        window.annotationsModule.cancelDrawingMode();
    }
    if (window.cancelMeasureMode) {
        window.cancelMeasureMode();
    }
    if (photoUploadMode) {
        cancelPhotoUpload();
    }
}

var UNIFIED_MAP_FILE_ACCEPT = '.pdf,.jpg,.jpeg,.png,.heic,.heif,.geojson,.json,.kml,.kmz,.zip,.shp';
var GEOSPATIAL_UPLOAD_EXTENSIONS = ['.geojson', '.json', '.kml', '.kmz', '.zip', '.shp'];

function classifyMapUploadFile(file) {
    const fileName = (file.name || '').toLowerCase();
    const extension = fileName.lastIndexOf('.') >= 0 ? fileName.substring(fileName.lastIndexOf('.')) : '';
    const imageExt = /\.(jpe?g|png|heic|heif)$/i;
    const isImage = (file.type && file.type.startsWith('image/')) || imageExt.test(fileName);
    if (isImage) return 'image';
    if (extension === '.pdf') return 'pdf';
    if (GEOSPATIAL_UPLOAD_EXTENSIONS.includes(extension)) return 'geo';
    return 'unsupported';
}

function showZipUnpackingStatus() {
    const el = document.getElementById('photoUploadStatus');
    const textEl = el ? el.querySelector('.photo-upload-status-text') : null;
    if (!el || !textEl) return;
    el.className = 'photo-upload-status';
    el.style.display = 'flex';
    textEl.textContent = 'Unpacking zip…';
}

function importGeoUploadFile(file) {
    const maxSize = 1 * 1024 * 1024;
    if (file.size > maxSize) {
        const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
        void appAlert(
            'File size (' + fileSizeMB + ' MB) exceeds the 1 MB limit. Please use a smaller file.'
        );
        return;
    }
    if (window.fileImportModule && window.fileImportModule.parseDataFile) {
        const el = document.getElementById('photoUploadStatus');
        const textEl = el ? el.querySelector('.photo-upload-status-text') : null;
        if (el && textEl) {
            el.className = 'photo-upload-status';
            el.style.display = 'flex';
            textEl.textContent = 'Importing ' + truncateMapUploadFileName(file.name) + '…';
        }
        window.fileImportModule.parseDataFile(file);
        setTimeout(hidePhotoUploadStatus, 1500);
    } else {
        console.error('File import module or parseDataFile function not available');
    }
}

async function routeSelectedMapFiles(files) {
    if (!files || !files.length) return;
    const list = Array.isArray(files) ? files : Array.from(files);
    const images = [];
    const documents = [];
    let importedGeo = false;
    let toClassify = list;
    const expandFn = typeof window.expandUploadFiles === 'function' ? window.expandUploadFiles : null;
    const hasZip = list.some(function (file) {
        return typeof window.isZipUploadFile === 'function'
            ? window.isZipUploadFile(file)
            : /\.zip$/i.test(file && file.name ? file.name : '');
    });
    if (expandFn && hasZip) {
        showZipUnpackingStatus();
        try {
            const expanded = await expandFn(list);
            toClassify = expanded.passthrough || [];
            (expanded.images || []).forEach(function (file) {
                images.push(file);
            });
            (expanded.documents || []).forEach(function (file) {
                documents.push(file);
            });
            (expanded.geoFiles || []).forEach(function (file) {
                importedGeo = true;
                importGeoUploadFile(file);
            });
            (expanded.errors || []).forEach(function (message) {
                void appAlert(message);
            });
            if (expanded.imagesOmitted > 0 && isMobileDevice()) {
                void appAlert(
                    'On mobile you can upload up to ' +
                        PHOTO_MOBILE_MAX_FILES_PER_PICK +
                        ' photos at once. Using the first ' +
                        PHOTO_MOBILE_MAX_FILES_PER_PICK +
                        ' (' +
                        expanded.imagesOmitted +
                        ' not included).'
                );
            }
        } catch (err) {
            console.error('Zip expand failed:', err);
            void appAlert('Could not read zip.');
        }
    }
    toClassify.forEach(function (file) {
        const kind = classifyMapUploadFile(file);
        if (kind === 'image') {
            images.push(file);
        } else if (kind === 'pdf') {
            documents.push(file);
        } else if (kind === 'geo') {
            importedGeo = true;
            importGeoUploadFile(file);
        } else {
            const fileName = (file.name || '').toLowerCase();
            const extension = fileName.lastIndexOf('.') >= 0 ? fileName.substring(fileName.lastIndexOf('.')) : '';
            void appAlert(
                'Unsupported file type: ' +
                    (extension || file.type || 'unknown') +
                    '. Supported: images, .pdf, .geojson, .json, .kml, .kmz, .zip, .shp'
            );
        }
    });
    if (documents.length > 0) {
        documents.forEach(function (file) {
            if (window.documentsModule && window.documentsModule.uploadDocument) {
                window.documentsModule.uploadDocument(file);
            } else {
                console.error('Documents module or uploadDocument function not available');
            }
        });
    }
    if (images.length > 0) {
        handlePhotoFiles(images);
    } else if (!importedGeo) {
        hidePhotoUploadStatus();
    }
}

function ensurePhotoGalleryFileInputBound() {
    const persistentInput = document.getElementById('photoGalleryFileInput');
    if (!persistentInput || persistentInput.dataset.galleryBound) return;
    persistentInput.dataset.galleryBound = '1';
    var lastGalleryPickToken = '';
    function onGalleryPick(e) {
        const input = e.target;
        const files = input.files;
        if (!files || files.length === 0) return;
        const first = files[0];
        const token =
            files.length +
            ':' +
            (first.name || '') +
            ':' +
            String(first.size) +
            ':' +
            String(first.lastModified);
        if (token === lastGalleryPickToken) return;
        lastGalleryPickToken = token;
        setTimeout(function () {
            lastGalleryPickToken = '';
        }, 400);
        const filesArray = Array.from(files);
        const mode = input.dataset.pickMode || 'unified';
        input.dataset.pickMode = 'unified';
        input.value = '';
        if (mode === 'inPageCamera') {
            const hasImageOrZip = filesArray.some(function (f) {
                return (
                    (f.type && f.type.startsWith('image/')) ||
                    /\.(jpe?g|png|heic|heif|zip)$/i.test(f.name || '')
                );
            });
            if (!hasImageOrZip) {
                void appAlert(
                    typeof window.t === 'function'
                        ? window.t('Please choose image files to upload.')
                        : 'Please choose image files to upload.'
                );
                return;
            }
            void (async function () {
                const closed = await ipcCloseCameraForGalleryImport();
                if (!closed) return;
                await routeSelectedMapFiles(filesArray);
            })();
            return;
        }
        void routeSelectedMapFiles(filesArray);
    }
    persistentInput.addEventListener('change', onGalleryPick);
    persistentInput.addEventListener('input', onGalleryPick);
}

function triggerHiddenFileInputClick(input) {
    if (!input) return;
    ensurePhotoGalleryFileInputBound();
    requestAnimationFrame(function () {
        requestAnimationFrame(function () {
            try {
                input.click();
            } catch (err) {
                console.error('File picker click failed', err);
            }
        });
    });
}

function clickPhotoGalleryFileInput(pickMode) {
    const persistentInput = document.getElementById('photoGalleryFileInput');
    if (!persistentInput) return false;
    persistentInput.dataset.pickMode = pickMode || 'unified';
    if (pickMode === 'images' || pickMode === 'inPageCamera') {
        persistentInput.accept = '.pdf,.jpg,.jpeg,.png,.heic,.heif,.zip';
    } else {
        persistentInput.accept = UNIFIED_MAP_FILE_ACCEPT;
    }
    triggerHiddenFileInputClick(persistentInput);
    return true;
}

function openUnifiedMapFilePicker() {
    const map = window.map;
    if (!map && !photoUploadAllowsMissingMap()) {
        const m = 'The map is not ready yet. Please wait for the page to finish loading, then try again.';
        void appAlert(typeof window.t === 'function' ? window.t(m) : m);
        return;
    }
    cancelActiveMapModesForUpload();

    const persistentInput = document.getElementById('photoGalleryFileInput');
    if (persistentInput) {
        persistentInput.dataset.pickMode = 'unified';
        persistentInput.accept = UNIFIED_MAP_FILE_ACCEPT;
        triggerHiddenFileInputClick(persistentInput);
        return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = UNIFIED_MAP_FILE_ACCEPT;
    input.multiple = true;

    function processSelectedFiles(event) {
        const files = event.target.files;
        if (files && files.length > 0) {
            const filesArray = Array.from(files);
            setTimeout(function () {
                routeSelectedMapFiles(filesArray);
            }, 0);
            setTimeout(function () {
                if (input.parentNode) {
                    input.parentNode.removeChild(input);
                }
            }, 500);
            input.onchange = null;
            input.oninput = null;
        }
        input.value = '';
    }

    input.onchange = processSelectedFiles;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);
    triggerHiddenFileInputClick(input);
    setTimeout(function () {
        if (input.parentNode) {
            input.parentNode.removeChild(input);
        }
    }, 60000);
}

async function ipcConfirmDiscardUnsentCameraQueue() {
    if (ipcQueue.length === 0) return true;
    const title = typeof window.t === 'function' ? window.t('Discard unsent photos?') : 'Discard unsent photos?';
    const body =
        typeof window.t === 'function'
            ? window.t(
                  'Photos still waiting to upload will be discarded. Photos already uploading will usually finish saving.'
              )
            : 'Photos still waiting to upload will be discarded. Photos already uploading will usually finish saving.';
    const confirmed = await appConfirm(body, {
        title: title,
        cancelText: typeof window.t === 'function' ? window.t('Stay') : 'Stay',
        confirmText: typeof window.t === 'function' ? window.t('Discard and close') : 'Discard and close',
    });
    if (!confirmed) return false;
    ipcQueue = [];
    ipcFootProgressFromState();
    return true;
}

async function ipcCloseCameraForGalleryImport() {
    const ok = await ipcConfirmDiscardUnsentCameraQueue();
    if (!ok) return false;
    const uploadedThisSession = ipcUploadedOkSession > 0;
    ipcTeardownCameraAndGeo();
    if (window.photoStakeOverlay && typeof window.photoStakeOverlay.teardownStakeOverlay === 'function') {
        window.photoStakeOverlay.teardownStakeOverlay();
    }
    ipcHideOverlay();
    currentBatchId = null;
    ipcUnregisterInPageCameraBack(false);
    const dataWindow = document.getElementById('dataWindow');
    const hubOpen = dataWindow && dataWindow.classList.contains('show');
    if (hubOpen && uploadedThisSession && window.filterDataTable) {
        window.filterDataTable();
    }
    return true;
}

function importPhotosFromInPageCamera() {
    const persistentInput = document.getElementById('photoGalleryFileInput');
    if (!persistentInput) {
        void initPhotoUploadFromGallery();
        return;
    }
    persistentInput.dataset.pickMode = 'inPageCamera';
    persistentInput.accept = '.pdf,.jpg,.jpeg,.png,.heic,.heif,.zip';
    triggerHiddenFileInputClick(persistentInput);
}

// Initialize photo upload from camera
function initPhotoUploadFromCamera() {
    const map = window.map;
    if (!map && !photoUploadAllowsMissingMap()) {
        const m = 'The map is not ready yet. Please wait for the page to finish loading, then try again.';
        void appAlert(typeof window.t === 'function' ? window.t(m) : m);
        return;
    }
    
    // Cancel any active drawing or measuring
    if (window.annotationsModule && window.annotationsModule.cancelDrawingMode) {
        window.annotationsModule.cancelDrawingMode();
    }
    if (window.cancelMeasureMode) {
        window.cancelMeasureMode();
    }
    if (photoUploadMode) {
        cancelPhotoUpload();
    }
    
    const persistentInput = document.getElementById('photoCameraFileInput');
    if (persistentInput && isMobileDevice()) {
        if (!persistentInput.dataset.bound) {
            persistentInput.dataset.bound = '1';
            persistentInput.addEventListener('change', function onCameraChange(e) {
                const files = e.target.files;
                if (files && files.length > 0) {
                    handlePhotoFiles(Array.from(files), { useDeviceLocationIfNoExif: true });
                }
                e.target.value = '';
            });
            persistentInput.addEventListener('input', function onCameraInput(e) {
                const files = e.target.files;
                if (files && files.length > 0) {
                    handlePhotoFiles(Array.from(files), { useDeviceLocationIfNoExif: true });
                }
                e.target.value = '';
            });
        }
        persistentInput.click();
        return;
    }

    // Fallback: create file input (desktop or when persistent input missing)
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.capture = 'environment'; // Use back camera
    
    // Store files immediately when selected to prevent loss on mobile
    function processSelectedFiles(event) {
        const files = event.target.files;
        if (files && files.length > 0) {
            const filesArray = Array.from(files);
            setTimeout(() => {
                handlePhotoFiles(filesArray, { useDeviceLocationIfNoExif: true });
            }, 0);
            setTimeout(() => {
                if (input.parentNode) {
                    input.parentNode.removeChild(input);
                }
            }, 500);
            input.onchange = null;
            input.oninput = null;
        }
        input.value = '';
    }
    input.onchange = processSelectedFiles;
    input.oninput = processSelectedFiles;
    
    // Keep input in DOM so it stays alive while user selects (mobile gallery can take several seconds)
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);
    
    input.click();
    
    // Remove input after a delay to allow file selection to complete (long fallback if user cancels)
    setTimeout(() => {
        if (input.parentNode) {
            input.parentNode.removeChild(input);
        }
    }, 60000);
}

// Initialize photo upload from gallery
function initPhotoUploadFromGallery() {
    const map = window.map;
    if (!map && !photoUploadAllowsMissingMap()) {
        const m = 'The map is not ready yet. Please wait for the page to finish loading, then try again.';
        void appAlert(typeof window.t === 'function' ? window.t(m) : m);
        return;
    }

    cancelActiveMapModesForUpload();
    const persistentInput = document.getElementById('photoGalleryFileInput');
    if (persistentInput) {
        persistentInput.dataset.pickMode = 'images';
        persistentInput.accept = '.pdf,.jpg,.jpeg,.png,.heic,.heif,.zip';
        triggerHiddenFileInputClick(persistentInput);
        return;
    }

    // Fallback: create file input (desktop or when persistent input missing)
    const input = document.createElement('input');
    input.type = 'file';
    // Same pattern as document upload: include .pdf so mobile opens Files app. Zips are unpacked first.
    input.accept = '.pdf,.jpg,.jpeg,.png,.heic,.heif,.zip';
    input.multiple = true;
    
    function processSelectedFiles(event) {
        const files = event.target.files;
        if (files && files.length > 0) {
            // Convert FileList to Array immediately to preserve files (critical on mobile)
            const filesArray = Array.from(files);
            // Process files asynchronously to ensure they're captured
            setTimeout(() => {
                void routeSelectedMapFiles(filesArray);
            }, 0);
            // Remove input only after we've captured the file references (don't remove before user confirms on mobile)
            setTimeout(() => {
                if (input.parentNode) {
                    input.parentNode.removeChild(input);
                }
            }, 500);
            input.onchange = null;
            input.oninput = null;
        }
        input.value = '';
    }
    
    input.onchange = processSelectedFiles;
    // Some mobile browsers fire 'input' instead of or in addition to 'change' for file selection
    input.oninput = processSelectedFiles;
    
    // Keep input in DOM so it stays alive while user selects from gallery (mobile can take several seconds)
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);
    
    input.click();
    
    // Long fallback: remove input only if user cancels picker (no selection after 60s)
    setTimeout(() => {
        if (input.parentNode) {
            input.parentNode.removeChild(input);
        }
    }, 60000);
}

// -----------------------------------------------------------------------------
// In-page camera (HTTPS getUserMedia): fullscreen native-style UI, watchPosition
// (or shared live fix) + compass heading + bottom-left micromap while open.
// -----------------------------------------------------------------------------
var IN_PAGE_CAMERA_MAX_CONCURRENT_UPLOADS = 3;
var IN_PAGE_CAMERA_SHUTTER_MS = 700;

var ipcStream = null;
var ipcUnsubscribeLocationFix = null;
var ipcFacingMode = 'environment';
var ipcUISession = 0;
var ipcCaptureCount = 0;
var ipcLastCaptureStartedAt = 0;
var ipcUploadedOkSession = 0;
var ipcQueue = [];
var ipcActiveUploads = 0;
var ipcControlsBound = false;
var ipcAppLifecycleBound = false;
/** Saved `meta[name=viewport]` while in-page camera forces no-zoom (restored on close). */
var ipcViewportMetaSavedContent = null;
var IPC_CAMERA_BACK_ID = 'inPageCamera';
var IPC_CAMERA_Z_DEFAULT = 68000;
/** Above #dirtReportModal (70000) and app dialogs (75000) when capturing DIRT evidence photos. */
var IPC_CAMERA_Z_ABOVE_DIRT = 76000;

function ipcRegisterInPageCameraBack() {
    if (!window.uiBackStack) return;
    window.uiBackStack.register({
        id: IPC_CAMERA_BACK_ID,
        isOpen: isInPageCameraOverlayOpen,
        onBack: function () {
            void ipcCloseInPageCamera({ fromBack: true });
        },
    });
}

function ipcUnregisterInPageCameraBack(fromBack) {
    if (!window.uiBackStack || !window.uiBackStack.isRegistered(IPC_CAMERA_BACK_ID)) return;
    window.uiBackStack.unregister(IPC_CAMERA_BACK_ID, fromBack ? { fromPopstate: true } : undefined);
}

function ipcCloseInPageCameraOnAppHidden() {
    if (!isInPageCameraOverlayOpen()) return;
    ipcTeardownCameraAndGeo();
    ipcTeardownStakeIfActive();
    ipcHideOverlay();
    ipcUnregisterInPageCameraBack(false);
}

function ipcEnsureAppLifecycleBound() {
    if (ipcAppLifecycleBound) return;
    ipcAppLifecycleBound = true;
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') {
            ipcCloseInPageCameraOnAppHidden();
        }
    });
    window.addEventListener('pagehide', function () {
        ipcCloseInPageCameraOnAppHidden();
    });
}

function ipcIsDirtReportModalOpen() {
    const m = document.getElementById('dirtReportModal');
    if (!m) return false;
    const display = (m.style.display || '').trim();
    return display !== '' && display !== 'none';
}

function ipcShouldRaiseCameraAboveDirtModal() {
    return (
        ipcIsDirtReportModalOpen() ||
        !!(window.photoUploadAssociationContext && window.photoUploadAssociationContext.source === 'dirt')
    );
}

function ipcApplyCameraOverlayZIndex() {
    const el = document.getElementById('inPageCameraOverlay');
    if (!el) return;
    el.style.zIndex = String(
        ipcShouldRaiseCameraAboveDirtModal() ? IPC_CAMERA_Z_ABOVE_DIRT : IPC_CAMERA_Z_DEFAULT
    );
}

function ipcRestoreCameraOverlayZIndex() {
    const el = document.getElementById('inPageCameraOverlay');
    if (!el) return;
    el.style.zIndex = String(IPC_CAMERA_Z_DEFAULT);
}

function ipcRestoreBodyOverflowAfterCamera() {
    if (
        typeof window.restoreDirtReportModalAfterCamera === 'function' &&
        window._dirtReportModalWasOpenForCamera
    ) {
        window.restoreDirtReportModalAfterCamera();
        return;
    }
    if (ipcIsDirtReportModalOpen()) {
        document.body.style.overflow = 'hidden';
        return;
    }
    document.body.style.overflow = '';
}

function ipcLockViewportNoZoom() {
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    if (ipcViewportMetaSavedContent === null) {
        ipcViewportMetaSavedContent = meta.getAttribute('content') || '';
    }
    meta.setAttribute(
        'content',
        'width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no'
    );
}

function ipcUnlockViewportNoZoom() {
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta || ipcViewportMetaSavedContent === null) return;
    meta.setAttribute('content', ipcViewportMetaSavedContent);
    ipcViewportMetaSavedContent = null;
}

function syncMobileInPageCameraButtonVisibility() {
    if (typeof window.syncMapToolActionVisibility === 'function') {
        window.syncMapToolActionVisibility();
    }
}

function ensureIPCPhotoBatch() {
    if (currentBatchId) return;
    const batchId = 'batch-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    currentBatchId = batchId;
    const currentOrgId = resolveCurrentOrgId();
    photoBatches.push({
        id: batchId,
        name: null,
        photoIds: [],
        createdAt: new Date().toISOString(),
        organizationId: currentOrgId
    });
    savePhotoBatches();
}

function ipcPinCurrentBatchOrNull() {
    const bid = currentBatchId;
    if (!bid) return null;
    const b = photoBatches.find(function (x) { return x.id === bid; });
    return { batchId: bid, batchName: (b && b.name) ? b.name : null };
}

function ipcFootProgressFromState() {
    const mQueued = ipcQueue.length + ipcActiveUploads;
    showInPageCameraUploadProgress(ipcUploadedOkSession, mQueued);
}

function ipcProcessUploadQueue() {
    while (ipcActiveUploads < IN_PAGE_CAMERA_MAX_CONCURRENT_UPLOADS && ipcQueue.length > 0) {
        const task = ipcQueue.shift();
        ipcActiveUploads++;
        ipcFootProgressFromState();
        (function bindTask(t) {
            uploadPhotoToBackend(t.file, t.latlng, t.exifData, null, null, t.batchPin).then(function (ok) {
                if (ok && t.uiSession === ipcUISession) {
                    ipcUploadedOkSession++;
                }
                ipcFootProgressFromState();
            }).finally(function () {
                ipcActiveUploads--;
                ipcFootProgressFromState();
                ipcProcessUploadQueue();
            });
        })(task);
    }
}

function ipcEnqueuePhotoUpload(file, latlng, exifData, batchPin, uiSession) {
    ipcQueue.push({
        file: file,
        latlng: latlng,
        exifData: exifData,
        batchPin: batchPin,
        uiSession: uiSession
    });
    ipcFootProgressFromState();
    ipcProcessUploadQueue();
}

function ipcStopMediaTracks() {
    if (ipcStream) {
        ipcStream.getTracks().forEach(function (t) { t.stop(); });
        ipcStream = null;
    }
    const v = document.getElementById('inPageCameraVideo');
    if (v) v.srcObject = null;
}

function ipcStopGeoTracking() {
    if (typeof ipcUnsubscribeLocationFix === 'function') {
        ipcUnsubscribeLocationFix();
    }
    ipcUnsubscribeLocationFix = null;
    if (window.inPageCameraLocation && typeof window.inPageCameraLocation.stop === 'function') {
        window.inPageCameraLocation.stop();
    }
    ipcUpdateGpsAccuracyUI();
}

function ipcTeardownCameraAndGeo() {
    ipcStopMediaTracks();
    ipcStopGeoTracking();
}

function ipcApplyVideoMirrorClass() {
    const v = document.getElementById('inPageCameraVideo');
    if (!v) return;
    if (ipcFacingMode === 'environment') {
        v.classList.add('in-page-camera-video--environment');
    } else {
        v.classList.remove('in-page-camera-video--environment');
    }
}

/** Refresh the on-screen GPS accuracy label using the user's preferred units. */
function ipcUpdateGpsAccuracyUI() {
    const el = document.getElementById('inPageCameraGpsAccuracy');
    if (!el) return;
    const open = isInPageCameraOverlayOpen();
    if (!open) {
        el.hidden = true;
        return;
    }
    el.hidden = false;
    el.classList.remove(
        'in-page-camera-gps-accuracy--good',
        'in-page-camera-gps-accuracy--ok',
        'in-page-camera-gps-accuracy--poor'
    );
    const fix =
        window.inPageCameraLocation && typeof window.inPageCameraLocation.getFix === 'function'
            ? window.inPageCameraLocation.getFix()
            : null;
    const acc = fix && isFinite(fix.accuracy) ? fix.accuracy : null;
    if (acc == null) {
        el.textContent = ipcTr('Acquiring GPS…');
        return;
    }
    const meters = Math.max(0, acc);
    const mm = window.measureModule;
    el.textContent =
        mm && typeof mm.formatGpsAccuracyMeters === 'function'
            ? mm.formatGpsAccuracyMeters(meters)
            : '\u00B1' + Math.round(meters) + ' m';
    if (meters < 20) {
        el.classList.add('in-page-camera-gps-accuracy--good');
    } else if (meters <= 50) {
        el.classList.add('in-page-camera-gps-accuracy--ok');
    } else {
        el.classList.add('in-page-camera-gps-accuracy--poor');
    }
}

function ipcStartGeoTracking() {
    ipcStopGeoTracking();
    if (!window.inPageCameraLocation || typeof window.inPageCameraLocation.start !== 'function') {
        ipcUpdateGpsAccuracyUI();
        return;
    }
    window.inPageCameraLocation.start();
    if (typeof window.inPageCameraLocation.onFixChange === 'function') {
        ipcUnsubscribeLocationFix = window.inPageCameraLocation.onFixChange(function () {
            ipcUpdateGpsAccuracyUI();
        });
    }
    ipcUpdateGpsAccuracyUI();
}

function ipcTr(attrKey) {
    return typeof window.t === 'function' ? window.t(attrKey) : attrKey;
}

function ipcSetShutterEnabled(on) {
    const cap = document.getElementById('inPageCameraCaptureBtn');
    if (cap) {
        cap.disabled = !on;
        cap.setAttribute('aria-disabled', on ? 'false' : 'true');
    }
}

function ipcAbortStakeCameraAfterFailure() {
    ipcQueue = [];
    ipcTeardownCameraAndGeo();
    ipcTeardownStakeIfActive();
    ipcHideOverlay();
    currentBatchId = null;
    ipcUnregisterInPageCameraBack(false);
}

function ipcIsStakeCameraActive() {
    return !!(
        window.photoStakeOverlay &&
        typeof window.photoStakeOverlay.isActive === 'function' &&
        window.photoStakeOverlay.isActive()
    );
}

async function ipcStartCamera() {
    ipcApplyVideoMirrorClass();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const m = 'This browser does not support in-page camera access.';
        await appAlert(typeof window.t === 'function' ? window.t(m) : m);
        if (ipcIsStakeCameraActive()) ipcAbortStakeCameraAfterFailure();
        return;
    }
    ipcStopMediaTracks();
    const video = document.getElementById('inPageCameraVideo');
    try {
        ipcStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: ipcFacingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
            audio: false
        });
        if (video) {
            video.srcObject = ipcStream;
            await video.play();
        }
        ipcSetShutterEnabled(true);
    } catch (e) {
        ipcSetShutterEnabled(false);
        await appAlert(
            typeof window.t === 'function'
                ? window.t('Camera failed: {detail}', { detail: e && e.message ? e.message : String(e) })
                : 'Camera failed: ' + (e && e.message ? e.message : String(e))
        );
        if (ipcIsStakeCameraActive()) ipcAbortStakeCameraAfterFailure();
    }
}

function ipcToggleFacingAndRestart() {
    ipcFacingMode = ipcFacingMode === 'environment' ? 'user' : 'environment';
    ipcApplyVideoMirrorClass();
    if (window.photoStakeOverlay && typeof window.photoStakeOverlay.onFacingModeChanged === 'function') {
        window.photoStakeOverlay.onFacingModeChanged(ipcFacingMode);
    }
    void ipcStartCamera();
}

function ipcGetFacingMode() {
    return ipcFacingMode;
}

function ipcCapturePhoto() {
    const video = document.getElementById('inPageCameraVideo');
    if (!video || !ipcStream || video.readyState < 2) return;
    const now = Date.now();
    if (now < ipcLastCaptureStartedAt + IN_PAGE_CAMERA_SHUTTER_MS) return;
    ipcLastCaptureStartedAt = now;

    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (ipcFacingMode === 'user') {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, w, h);

    const shutterFix =
        window.inPageCameraLocation && typeof window.inPageCameraLocation.getFix === 'function'
            ? window.inPageCameraLocation.getFix()
            : null;
    let latlng = null;
    if (shutterFix && isFinite(shutterFix.lat) && isFinite(shutterFix.lng)) {
        latlng = L.latLng(shutterFix.lat, shutterFix.lng);
    }
    const exifData = latlng
        ? { gpsSource: 'Device', hasGPS: true, gpsLat: latlng.lat, gpsLng: latlng.lng }
        : {};
    if (latlng && shutterFix && isFinite(shutterFix.accuracy)) {
        exifData.gpsAccuracyMeters = shutterFix.accuracy;
    }
    if (shutterFix && isFinite(shutterFix.heading)) {
        exifData.gpsHeadingDegrees = shutterFix.heading;
        exifData.gpsHeadingSource = shutterFix.headingSource || 'Compass';
    }
    if (window.photoStakeOverlay && typeof window.photoStakeOverlay.isActive === 'function' && window.photoStakeOverlay.isActive()) {
        const stakeCtx =
            typeof window.photoStakeOverlay.getActiveStakeContext === 'function'
                ? window.photoStakeOverlay.getActiveStakeContext()
                : null;
        if (stakeCtx && stakeCtx.referencePhotoId != null) {
            exifData.stakeOfPhotoId = stakeCtx.referencePhotoId;
            exifData.stakeGhostOpacity =
                typeof window.photoStakeOverlay.getStakeOpacity === 'function'
                    ? window.photoStakeOverlay.getStakeOpacity()
                    : null;
            const dirtCtx = window.photoUploadAssociationContext;
            if (
                stakeCtx.sourceAssociatedTicketId != null &&
                Number.isFinite(Number(stakeCtx.sourceAssociatedTicketId)) &&
                !(dirtCtx && dirtCtx.source === 'dirt')
            ) {
                exifData.associatedTicketId = Number(stakeCtx.sourceAssociatedTicketId);
            }
        }
    }

    photoCanvas().canvasToJpegBlob(canvas, 0.92).then(function (blob) {
        if (!blob) return;
        ipcCaptureCount++;
        const fname = 'camera-' + Date.now() + '.jpg';
        const file = new File([blob], fname, { type: 'image/jpeg', lastModified: Date.now() });
        ensureIPCPhotoBatch();
        const pin = ipcPinCurrentBatchOrNull();
        ipcEnqueuePhotoUpload(file, latlng, exifData, pin, ipcUISession);
    });
}

function isInPageCameraOverlayOpen() {
    const el = document.getElementById('inPageCameraOverlay');
    return !!(el && el.style.display !== 'none' && el.getAttribute('aria-hidden') !== 'true');
}

function hasActivePhotoUploadWork() {
    return ipcQueue.length > 0 || ipcActiveUploads > 0;
}

function ipcHideOverlay() {
    const el = document.getElementById('inPageCameraOverlay');
    if (el) {
        el.style.display = 'none';
        el.setAttribute('aria-hidden', 'true');
    }
    const galleryBtn = document.getElementById('inPageCameraGalleryBtn');
    if (galleryBtn) galleryBtn.hidden = true;
    ipcTeardownStakeIfActive();
    ipcRestoreCameraOverlayZIndex();
    ipcRestoreBodyOverflowAfterCamera();
    ipcUnlockViewportNoZoom();
}

function ipcShowOverlayPrep(options) {
    options = options || {};
    ipcUISession++;
    ipcCaptureCount = 0;
    ipcLastCaptureStartedAt = 0;
    ipcUploadedOkSession = 0;
    ipcFacingMode = 'environment';
    ipcTeardownCameraAndGeo();
    ipcSetShutterEnabled(false);
    if (!options.stakeMode) {
        ipcTeardownStakeIfActive();
    }

    const el = document.getElementById('inPageCameraOverlay');
    if (el) {
        ipcApplyCameraOverlayZIndex();
        el.style.display = 'flex';
        el.style.alignItems = 'stretch';
        el.style.justifyContent = 'stretch';
        el.setAttribute('aria-hidden', 'false');
    }
    document.body.style.overflow = 'hidden';

    ipcLockViewportNoZoom();
    ipcApplyVideoMirrorClass();
    ipcStartGeoTracking();
    ipcFootProgressFromState();

    // Micromap Leaflet needs a laid-out container; refresh after the overlay paints.
    if (window.inPageCameraLocation && typeof window.inPageCameraLocation.refreshMicromap === 'function') {
        requestAnimationFrame(function () {
            window.inPageCameraLocation.refreshMicromap();
            setTimeout(function () {
                if (window.inPageCameraLocation && typeof window.inPageCameraLocation.refreshMicromap === 'function') {
                    window.inPageCameraLocation.refreshMicromap();
                }
            }, 200);
        });
    }

    ipcEnsureOverlayControlsBound();
    ipcEnsureAppLifecycleBound();
    const galleryBtn = document.getElementById('inPageCameraGalleryBtn');
    if (galleryBtn) galleryBtn.hidden = false;
    ipcRegisterInPageCameraBack();
    void ipcStartCamera();
}

function ipcEnsureOverlayControlsBound() {
    if (ipcControlsBound) return;
    ipcControlsBound = true;

    const overlay = document.getElementById('inPageCameraOverlay');
    if (overlay && !overlay.dataset.ipcZoomGuard) {
        overlay.dataset.ipcZoomGuard = '1';
        function preventPinchZoomGestures(e) {
            e.preventDefault();
        }
        overlay.addEventListener('gesturestart', preventPinchZoomGestures, { passive: false });
        overlay.addEventListener('gesturechange', preventPinchZoomGestures, { passive: false });
        overlay.addEventListener('gestureend', preventPinchZoomGestures, { passive: false });
        overlay.addEventListener(
            'wheel',
            function (e) {
                if (e.ctrlKey) e.preventDefault();
            },
            { passive: false }
        );
    }

    const closeBtn = document.getElementById('inPageCameraCloseBtn');
    const switchBtn = document.getElementById('inPageCameraSwitchBtn');
    const capBtn = document.getElementById('inPageCameraCaptureBtn');

    if (closeBtn) {
        closeBtn.setAttribute('aria-label', ipcTr('Close'));
        closeBtn.addEventListener('click', function () { void ipcCloseInPageCamera(); });
    }
    if (switchBtn) {
        switchBtn.setAttribute('aria-label', ipcTr('Switch camera'));
        switchBtn.addEventListener('click', function () { ipcToggleFacingAndRestart(); });
    }
    if (capBtn) {
        capBtn.setAttribute('aria-label', ipcTr('Capture photo'));
        capBtn.addEventListener('click', ipcCapturePhoto);
    }
    const galleryBtn = document.getElementById('inPageCameraGalleryBtn');
    if (galleryBtn) {
        galleryBtn.setAttribute('aria-label', ipcTr('Upload photos'));
        galleryBtn.addEventListener('click', function () {
            if (typeof window.runMapToolAction === 'function') {
                window.runMapToolAction('importPhotos', { fromInPageCamera: true });
            } else if (typeof window.importPhotosFromInPageCamera === 'function') {
                void window.importPhotosFromInPageCamera();
            }
        });
    }
}

/**
 * Single close control: if photos are still queued (not yet uploading), confirm discard.
 * In-flight uploads keep running; Finished batch id is cleared so the next gallery batch is fresh.
 */
async function ipcCloseInPageCamera(opts) {
    opts = opts || {};
    if (ipcQueue.length > 0) {
        const title = typeof window.t === 'function'
            ? window.t('Discard unsent photos?')
            : 'Discard unsent photos?';
        const body =
            typeof window.t === 'function'
                ? window.t(
                    'Photos still waiting to upload will be discarded. Photos already uploading will usually finish saving.'
                )
                : 'Photos still waiting to upload will be discarded. Photos already uploading will usually finish saving.';
        const confirmed = await appConfirm(body, {
            title: title,
            cancelText: typeof window.t === 'function' ? window.t('Stay') : 'Stay',
            confirmText: typeof window.t === 'function' ? window.t('Discard and close') : 'Discard and close'
        });
        if (!confirmed) {
            if (opts.fromBack && window.uiBackStack && typeof window.uiBackStack.rearmAfterPopstate === 'function') {
                window.uiBackStack.rearmAfterPopstate();
            }
            return false;
        }
        ipcQueue = [];
        ipcFootProgressFromState();
    }
    ipcTeardownCameraAndGeo();
    if (window.photoStakeOverlay && typeof window.photoStakeOverlay.teardownStakeOverlay === 'function') {
        window.photoStakeOverlay.teardownStakeOverlay();
    }
    const uploadedThisSession = ipcUploadedOkSession > 0;
    ipcHideOverlay();
    currentBatchId = null;
    ipcUnregisterInPageCameraBack(opts.fromBack);
    const dataWindow = document.getElementById('dataWindow');
    const hubOpen = dataWindow && dataWindow.classList.contains('show');
    if (hubOpen && uploadedThisSession && window.filterDataTable) {
        window.filterDataTable();
    }
    return true;
}

function ipcTeardownStakeIfActive() {
    if (window.photoStakeOverlay && typeof window.photoStakeOverlay.teardownStakeOverlay === 'function') {
        window.photoStakeOverlay.teardownStakeOverlay();
    }
}

function initPhotoUploadFromInPageCamera(options) {
    options = options || {};
    if (window.inPageCameraLocation && typeof window.inPageCameraLocation.requestCompassPermission === 'function') {
        void window.inPageCameraLocation.requestCompassPermission();
    }
    const stakeActive =
        window.photoStakeOverlay &&
        typeof window.photoStakeOverlay.isActive === 'function' &&
        window.photoStakeOverlay.isActive();
    const dirtCapture =
        window.photoUploadAssociationContext && window.photoUploadAssociationContext.source === 'dirt';
    const map = window.map;
    if (!map && !dirtCapture && !stakeActive && !options.allowWithoutMap) {
        const m = 'The map is not ready yet. Please wait for the page to finish loading, then try again.';
        void appAlert(typeof window.t === 'function' ? window.t(m) : m);
        ipcTeardownStakeIfActive();
        return false;
    }

    if (window.annotationsModule && window.annotationsModule.cancelDrawingMode) {
        window.annotationsModule.cancelDrawingMode();
    }
    if (window.cancelMeasureMode) window.cancelMeasureMode();
    if (photoUploadMode) cancelPhotoUpload();

    if (
        typeof window !== 'undefined' &&
        (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
    ) {
        const m =
            'In-page camera requires a secure connection (HTTPS or localhost). Use Choose photo files instead.';
        void appAlert(typeof window.t === 'function' ? window.t(m) : m);
        ipcTeardownStakeIfActive();
        return false;
    }

    ipcEnsureOverlayControlsBound();
    ipcShowOverlayPrep(options);
    return true;
}

async function openPhotoStakeCamera(photoId) {
    const modal = document.getElementById('photoViewerModal');
    const resolvedId =
        photoId != null && photoId !== ''
            ? photoId
            : modal && modal.dataset.currentPhotoId
              ? modal.dataset.currentPhotoId
              : null;
    const photo =
        typeof findPhotoForUi === 'function' && resolvedId != null ? findPhotoForUi(resolvedId) : null;
    if (!photo || photo.fileId == null || !Number.isFinite(Number(photo.fileId))) {
        const m = 'This photo cannot be used for match mode.';
        void appAlert(typeof window.t === 'function' ? window.t(m) : m);
        return;
    }
    if (!window.photoStakeOverlay || typeof window.photoStakeOverlay.prepareStakeOverlayForPhoto !== 'function') {
        const m = 'Match this shot is not available yet. Please refresh the page.';
        void appAlert(typeof window.t === 'function' ? window.t(m) : m);
        return;
    }

    const stakeContext = await window.photoStakeOverlay.prepareStakeOverlayForPhoto(photo);
    if (!stakeContext || !stakeContext.ghostDataUrl) {
        const m =
            "Couldn't load the reference photo. Connect to the network or open the photo once while online, then try again.";
        void appAlert(typeof window.t === 'function' ? window.t(m) : m);
        return;
    }

    closePhotoViewer();
    if (window.photoClusterDrawerModule && typeof window.photoClusterDrawerModule.closePhotoClusterDrawer === 'function') {
        window.photoClusterDrawerModule.closePhotoClusterDrawer();
    }
    if (typeof window.closeTicketPhotosSideGallery === 'function') {
        window.closeTicketPhotosSideGallery();
    }
    if (!initPhotoUploadFromInPageCamera({ allowWithoutMap: true, stakeMode: true })) {
        return;
    }
    window.photoStakeOverlay.showPreparedContext(stakeContext);
}

var photoViewerMatchShotBound = false;

function ensurePhotoViewerMatchShotBound() {
    if (photoViewerMatchShotBound) return;
    const btn = document.getElementById('photoViewerMatchShotBtn');
    if (!btn) return;
    photoViewerMatchShotBound = true;
    if (!window.__photoViewerStakeLayoutResizeBound) {
        window.__photoViewerStakeLayoutResizeBound = true;
        window.addEventListener('resize', syncPhotoViewerMicromapOffset);
    }
    btn.addEventListener('click', function () {
        const modal = document.getElementById('photoViewerModal');
        const pid = modal && modal.dataset.currentPhotoId ? modal.dataset.currentPhotoId : null;
        void openPhotoStakeCamera(pid);
    });
}

function syncPhotoViewerBottomLeftVisibility() {
    const wrap = document.getElementById('photoViewerBottomLeft');
    if (!wrap) return;
    const match = document.getElementById('photoViewerMatchShotBtn');
    const compare = document.getElementById('photoViewerCompareBtn');
    const anyVisible = (match && !match.hidden) || (compare && !compare.hidden);
    wrap.hidden = !anyVisible;
    syncPhotoViewerMicromapOffset();
}

function syncPhotoViewerMatchShotButton(photo) {
    ensurePhotoViewerMatchShotBound();
    const btn = document.getElementById('photoViewerMatchShotBtn');
    if (!btn) return;
    const canMatch =
        photo &&
        photo.fileId != null &&
        Number.isFinite(Number(photo.fileId)) &&
        typeof window !== 'undefined' &&
        window.isSecureContext &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function';
    btn.hidden = !canMatch;
    btn.title = typeof window.t === 'function' ? window.t('Match this shot') : 'Match this shot';
    btn.textContent = typeof window.t === 'function' ? window.t('Match') : 'Match';
    syncPhotoViewerBottomLeftVisibility();
}

function viewerTr(text) {
    return typeof window.t === 'function' ? window.t(text) : text;
}

function setPhotoViewerComparePosition(percent) {
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    photoViewerComparePosition = p;
    const clip = document.getElementById('photoViewerCompareClip');
    const handle = document.getElementById('photoViewerCompareHandle');
    if (clip) clip.style.width = p + '%';
    if (handle) {
        handle.style.left = p + '%';
        handle.setAttribute('aria-valuenow', String(Math.round(p)));
    }
}

function revokePhotoViewerCompareUrls() {
    const orig = document.getElementById('photoViewerCompareOriginal');
    const rest = document.getElementById('photoViewerCompareRestake');
    [orig, rest].forEach(function (img) {
        if (!img) return;
        const prev = img.dataset.objectUrl;
        if (prev && prev.startsWith('blob:')) {
            try {
                URL.revokeObjectURL(prev);
            } catch (_) {
                /* ignore */
            }
        }
        delete img.dataset.objectUrl;
        img.removeAttribute('src');
    });
}

function exitPhotoViewerCompare() {
    photoViewerCompareActive = false;
    const wrap = document.getElementById('photoViewerCompareWrap');
    const image = document.getElementById('photoViewerImage');
    const container = document.getElementById('photoViewerImageContainer');
    const compareBtn = document.getElementById('photoViewerCompareBtn');
    if (wrap) wrap.hidden = true;
    if (image) image.hidden = false;
    if (container) container.classList.remove('photo-viewer-image-container--compare');
    if (compareBtn) compareBtn.setAttribute('aria-pressed', 'false');
    revokePhotoViewerCompareUrls();
    setPhotoViewerComparePosition(50);
    if (photoViewerCurrentPhoto) {
        syncPhotoViewerMicromap(photoViewerCurrentPhoto);
    }
}

async function loadPhotoViewerCompareImageUrl(photo, preferFull) {
    const mod = window.photosModule;
    if (!photo) return null;
    if (preferFull && mod && typeof mod.getPhotoFullBlobCached === 'function' && photo.fileId != null) {
        try {
            const blob = await mod.getPhotoFullBlobCached(photo.fileId);
            if (blob) return URL.createObjectURL(blob);
        } catch (_) {
            /* fall through */
        }
    }
    if (mod && typeof mod.getPhotoImageUrlForViewer === 'function') {
        try {
            const url = await mod.getPhotoImageUrlForViewer(photo);
            if (url) return url;
        } catch (_) {
            /* ignore */
        }
    }
    if (photo.imageUrl) return photo.imageUrl;
    if (photo.fileId != null && mod && typeof mod.getPhotoThumbnailObjectUrlCached === 'function') {
        try {
            return await mod.getPhotoThumbnailObjectUrlCached(photo.fileId);
        } catch (_) {
            return null;
        }
    }
    return null;
}

async function enterPhotoViewerCompare(photo) {
    const utils = window.photoStakeUtils;
    if (!utils || typeof utils.isRestakedPhoto !== 'function' || !utils.isRestakedPhoto(photo)) return;
    if (!photoViewerCompareRefLoadable) return;

    const ref = typeof utils.resolveStakeReferencePhoto === 'function' ? utils.resolveStakeReferencePhoto(photo) : null;
    const refId = typeof utils.getPhotoStakeOfPhotoId === 'function' ? utils.getPhotoStakeOfPhotoId(photo) : null;
    const refFileId = ref && ref.fileId != null ? Number(ref.fileId) : refId;
    if (refFileId == null || !Number.isFinite(refFileId)) return;

    const refPhoto = ref || { fileId: refFileId, fileName: viewerTr('Original') };

    const wrap = document.getElementById('photoViewerCompareWrap');
    const image = document.getElementById('photoViewerImage');
    const origImg = document.getElementById('photoViewerCompareOriginal');
    const restImg = document.getElementById('photoViewerCompareRestake');
    const container = document.getElementById('photoViewerImageContainer');
    const compareBtn = document.getElementById('photoViewerCompareBtn');
    if (!wrap || !image || !origImg || !restImg) return;

    revokePhotoViewerCompareUrls();
    photoViewerCompareActive = true;
    clearPhotoViewerMicromap();
    if (container) container.classList.add('photo-viewer-image-container--compare');
    if (compareBtn) compareBtn.setAttribute('aria-pressed', 'true');
    image.hidden = true;
    wrap.hidden = false;
    setPhotoViewerComparePosition(50);

    photoViewerZoom = 1;
    photoViewerPanX = 0;
    photoViewerPanY = 0;
    updatePhotoViewerTransform();

    const origLabel = wrap.querySelector('.photo-viewer-compare-label--original');
    const restLabel = wrap.querySelector('.photo-viewer-compare-label--restake');
    if (origLabel) origLabel.textContent = viewerTr('Original');
    if (restLabel) restLabel.textContent = viewerTr('Restake');

    const [origUrl, restUrl] = await Promise.all([
        loadPhotoViewerCompareImageUrl(refPhoto, true),
        loadPhotoViewerCompareImageUrl(photo, true),
    ]);

    if (!photoViewerCompareActive) {
        if (origUrl && origUrl.startsWith('blob:')) URL.revokeObjectURL(origUrl);
        if (restUrl && restUrl.startsWith('blob:')) URL.revokeObjectURL(restUrl);
        return;
    }

    if (!origUrl || !restUrl) {
        if (origUrl && origUrl.startsWith('blob:')) URL.revokeObjectURL(origUrl);
        if (restUrl && restUrl.startsWith('blob:')) URL.revokeObjectURL(restUrl);
        exitPhotoViewerCompare();
        return;
    }

    origImg.src = origUrl;
    restImg.src = restUrl;
    if (origUrl.startsWith('blob:')) origImg.dataset.objectUrl = origUrl;
    if (restUrl.startsWith('blob:')) restImg.dataset.objectUrl = restUrl;

    const syncCompareLayout = function () {
        const wrapEl = document.getElementById('photoViewerCompareWrap');
        if (!wrapEl || !restImg) return;
        const w = wrapEl.clientWidth;
        if (w > 0) {
            restImg.style.width = w + 'px';
            restImg.style.maxWidth = 'none';
        }
    };
    origImg.onload = syncCompareLayout;
    restImg.onload = syncCompareLayout;
    syncCompareLayout();
}

function ensurePhotoViewerCompareBound() {
    if (photoViewerCompareBound) return;
    const btn = document.getElementById('photoViewerCompareBtn');
    const handle = document.getElementById('photoViewerCompareHandle');
    const wrap = document.getElementById('photoViewerCompareWrap');
    if (!btn) return;
    photoViewerCompareBound = true;

    btn.addEventListener('click', function () {
        if (btn.disabled) return;
        const modal = document.getElementById('photoViewerModal');
        const pid = modal && modal.dataset.currentPhotoId ? modal.dataset.currentPhotoId : null;
        const photo = typeof findPhotoForUi === 'function' && pid ? findPhotoForUi(pid) : null;
        if (!photo) return;
        if (photoViewerCompareActive) {
            exitPhotoViewerCompare();
            return;
        }
        void enterPhotoViewerCompare(photo);
    });

    function onCompareDrag(clientX) {
        const container = document.getElementById('photoViewerImageContainer');
        if (!container || !photoViewerCompareActive) return;
        const rect = container.getBoundingClientRect();
        if (!rect.width) return;
        const pct = ((clientX - rect.left) / rect.width) * 100;
        setPhotoViewerComparePosition(pct);
    }

    if (handle) {
        handle.addEventListener('pointerdown', function (e) {
            if (!photoViewerCompareActive) return;
            e.preventDefault();
            const token = ++photoViewerCompareDragToken;
            handle.setPointerCapture(e.pointerId);
            const move = function (ev) {
                if (token !== photoViewerCompareDragToken) return;
                onCompareDrag(ev.clientX);
            };
            const up = function () {
                photoViewerCompareDragToken++;
                handle.removeEventListener('pointermove', move);
                handle.removeEventListener('pointerup', up);
                handle.removeEventListener('pointercancel', up);
            };
            handle.addEventListener('pointermove', move);
            handle.addEventListener('pointerup', up);
            handle.addEventListener('pointercancel', up);
        });
    }

    if (wrap) {
        wrap.addEventListener('click', function (e) {
            if (!photoViewerCompareActive || e.target === handle) return;
            onCompareDrag(e.clientX);
        });
    }
}

function syncPhotoViewerCompareButton(photo) {
    ensurePhotoViewerCompareBound();
    const btn = document.getElementById('photoViewerCompareBtn');
    if (!btn) return;

    btn.textContent = viewerTr('Compare');
    btn.title = viewerTr('Compare with original');
    btn.disabled = false;
    photoViewerCompareRefLoadable = false;
    photoViewerCompareCheckToken++;

    if (!photo) {
        btn.hidden = true;
        syncPhotoViewerBottomLeftVisibility();
        return;
    }

    const utils = window.photoStakeUtils;
    const isRestaked = utils && typeof utils.isRestakedPhoto === 'function' && utils.isRestakedPhoto(photo);

    if (!isRestaked) {
        btn.hidden = true;
        syncPhotoViewerBottomLeftVisibility();
        return;
    }

    const checkToken = photoViewerCompareCheckToken;
    const refId = typeof utils.getPhotoStakeOfPhotoId === 'function' ? utils.getPhotoStakeOfPhotoId(photo) : null;
    const ref = typeof utils.resolveStakeReferencePhoto === 'function' ? utils.resolveStakeReferencePhoto(photo) : null;
    const refFileId = ref && ref.fileId != null ? Number(ref.fileId) : refId;
    if (refFileId == null || !Number.isFinite(refFileId)) {
        btn.hidden = true;
        syncPhotoViewerBottomLeftVisibility();
        return;
    }

    btn.hidden = true;

    const mod = window.photosModule;
    const verifyLoadable = async function () {
        if (mod && typeof mod.getPhotoFullBlobCached === 'function') {
            try {
                const blob = await mod.getPhotoFullBlobCached(refFileId);
                if (blob) return true;
            } catch (_) {
                /* try url */
            }
        }
        const refPhoto = ref || { fileId: refFileId, fileName: 'Original' };
        const url = await loadPhotoViewerCompareImageUrl(refPhoto, false);
        return !!url;
    };

    void verifyLoadable().then(function (ok) {
        if (checkToken !== photoViewerCompareCheckToken) return;
        photoViewerCompareRefLoadable = ok;
        btn.hidden = !ok;
        btn.title = ok ? viewerTr('Compare with original') : viewerTr('Original unavailable');
        syncPhotoViewerBottomLeftVisibility();
    });
}

window.ipcGetFacingMode = ipcGetFacingMode;

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', syncMobileInPageCameraButtonVisibility);
    } else {
        syncMobileInPageCameraButtonVisibility();
    }
}

// Handle photo files (shared by both camera and gallery)
// options.useDeviceLocationIfNoExif: when true and a single photo has no EXIF GPS, use device location (e.g. Take photo on iPhone)
function handlePhotoFiles(files, options) {
    options = options || {};
    // Ensure files is an array (handle both FileList and Array)
    let filesArray = Array.isArray(files) ? files : (files ? Array.from(files) : []);
    // Only process image files (picker may allow others when using file extensions)
    const imageExt = /\.(jpe?g|png|heic|heif)$/i;
    const isImage = (f) => (f.type && f.type.startsWith('image/')) || imageExt.test(f.name || '');
    filesArray = filesArray.filter(isImage);
    
    if (filesArray.length === 0) return;

    if (typeof showPhotoUploadPreparing === 'function') {
        showPhotoUploadPreparing(filesArray.length);
    } else if (window.mapUploadStatusModule && window.mapUploadStatusModule.showPhotoUploadPreparing) {
        window.mapUploadStatusModule.showPhotoUploadPreparing(filesArray.length);
    }

    if (isMobileDevice() && filesArray.length > PHOTO_MOBILE_MAX_FILES_PER_PICK) {
        const dropped = filesArray.length - PHOTO_MOBILE_MAX_FILES_PER_PICK;
        filesArray = filesArray.slice(0, PHOTO_MOBILE_MAX_FILES_PER_PICK);
        void appAlert(
            'On mobile you can upload up to ' +
                PHOTO_MOBILE_MAX_FILES_PER_PICK +
                ' photos at once. Using the first ' +
                PHOTO_MOBILE_MAX_FILES_PER_PICK +
                ' (' +
                dropped +
                ' not included).'
        );
    }

    // Read EXIF (including GPS) from each file immediately at selection time and cache it,
    // so we can tag the photo after upload even if the file or app strips metadata later.
    readExifForFiles(filesArray).then(function (itemsWithExif) {
        // Camera single-photo fallback: if EXIF had no GPS, use device location (e.g. iPhone often omits GPS in capture)
        if (options.useDeviceLocationIfNoExif && itemsWithExif.length === 1 && (itemsWithExif[0].gps == null || (itemsWithExif[0].gps && !Number.isFinite(itemsWithExif[0].gps.lat)))) {
            getDeviceLocationThenProceed(itemsWithExif, handlePhotoFilesWithCachedExif);
            return;
        }
        handlePhotoFilesWithCachedExif(itemsWithExif).catch(function (e) {
            console.error('Photo upload batch failed:', e);
        });
    }).catch(function (err) {
        console.error('EXIF read failed, uploading without cached GPS:', err);
        var fallbackItems = filesArray.map(function (file) {
            const empty = emptyPhotoExifData();
            return {
                file: file,
                gps: null,
                exifData: empty,
                uploadManifest: buildPhotoUploadManifest(file, null, empty, null, false),
            };
        });
        if (options.useDeviceLocationIfNoExif && fallbackItems.length === 1) {
            getDeviceLocationThenProceed(fallbackItems, handlePhotoFilesWithCachedExif);
            return;
        }
        handlePhotoFilesWithCachedExif(fallbackItems).catch(function (e) {
            console.error('Photo upload batch failed:', e);
        });
    });
}

// Request device location; on success set item[0].gps and optionally exifData.gpsSource, then call onReady(items).
// On error or unsupported, call onReady(items) unchanged.
function getDeviceLocationThenProceed(items, onReady) {
    function finish(itemsArg) {
        if (!onReady) return;
        Promise.resolve(onReady(itemsArg)).catch(function (e) {
            console.error('Photo upload batch failed:', e);
        });
    }
    if (!items || items.length === 0) {
        finish(items);
        return;
    }
    if (!navigator.geolocation) {
        finish(items);
        return;
    }
    navigator.geolocation.getCurrentPosition(
        function (pos) {
            var item = items[0];
            if (item && pos && pos.coords && Number.isFinite(pos.coords.latitude) && Number.isFinite(pos.coords.longitude)) {
                item.gps = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                if (item.exifData) {
                    item.exifData.gpsSource = 'Device';
                    item.exifData.hasGPS = true;
                    item.exifData.gpsLat = item.gps.lat;
                    item.exifData.gpsLng = item.gps.lng;
                } else {
                    item.exifData = { gpsSource: 'Device', hasGPS: true, gpsLat: item.gps.lat, gpsLng: item.gps.lng };
                }
                syncUploadManifestExif(item.uploadManifest, item.exifData);
                if (Number.isFinite(pos.coords.accuracy)) {
                    item.exifData.gpsAccuracyMeters = pos.coords.accuracy;
                }
            }
            finish(items);
        },
        function () {
            finish(items);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
}

// Read EXIF (including GPS) from files as soon as they're selected; returns Promise<Array<{ file, gps, exifData, uploadManifest }>>.
// Short timeout per file so we don't hang on mobile. Cached GPS + manifest survive HEIC conversion.
function readExifForFiles(filesArray) {
    return Promise.all(filesArray.map(readExifFromOneFile));
}

async function readExifFromOneFileViaExifr(file) {
    const empty = emptyPhotoExifData();
    if (typeof window.__readPhotoExifFromFile !== 'function') {
        return {
            file: file,
            gps: null,
            exifData: empty,
            uploadManifest: buildPhotoUploadManifest(file, null, empty, null, false),
        };
    }
    const EXIF_READ_TIMEOUT_MS = 5000;
    try {
        const parsed = await Promise.race([
            window.__readPhotoExifFromFile(file),
            new Promise(function (_, reject) {
                setTimeout(function () {
                    reject(new Error('EXIF read timeout'));
                }, EXIF_READ_TIMEOUT_MS);
            }),
        ]);
        const gps = parsed && parsed.gps ? parsed.gps : null;
        const exifData = parsed && parsed.exifData ? parsed.exifData : empty;
        const exifTags = serializeExifTagsForManifest(parsed && parsed.exifRaw);
        const exifReadOk = !!(gps || exifData.dateTime || exifData.make || exifData.model);
        return {
            file: file,
            gps: gps,
            exifData: exifData,
            uploadManifest: buildPhotoUploadManifest(file, gps, exifData, exifTags, exifReadOk),
        };
    } catch (err) {
        console.warn('HEIC EXIF read failed:', err.message || err);
        return {
            file: file,
            gps: null,
            exifData: empty,
            uploadManifest: buildPhotoUploadManifest(file, null, empty, null, false),
        };
    }
}

function readExifFromOneFileViaExifJs(file) {
    return new Promise(function (resolve) {
        const EXIF_READ_TIMEOUT_MS = 2500;
        const timeout = setTimeout(function () {
            const empty = emptyPhotoExifData();
            resolve({
                file: file,
                gps: null,
                exifData: empty,
                uploadManifest: buildPhotoUploadManifest(file, null, empty, null, false),
            });
        }, EXIF_READ_TIMEOUT_MS);

        if (typeof EXIF === 'undefined') {
            clearTimeout(timeout);
            const empty = emptyPhotoExifData();
            resolve({
                file: file,
                gps: null,
                exifData: empty,
                uploadManifest: buildPhotoUploadManifest(file, null, empty, null, false),
            });
            return;
        }
        try {
            EXIF.getData(file, function () {
                clearTimeout(timeout);
                var lat = EXIF.getTag(this, 'GPSLatitude');
                var latRef = EXIF.getTag(this, 'GPSLatitudeRef');
                var lon = EXIF.getTag(this, 'GPSLongitude');
                var lonRef = EXIF.getTag(this, 'GPSLongitudeRef');
                if ((!lat || !lon) && this.exifdata) {
                    var d = this.exifdata;
                    lat = lat || d.GPSLatitude || d.gpsLatitude;
                    latRef = latRef != null ? latRef : (d.GPSLatitudeRef != null ? d.GPSLatitudeRef : d.gpsLatitudeRef);
                    lon = lon || d.GPSLongitude || d.gpsLongitude;
                    lonRef = lonRef != null ? lonRef : (d.GPSLongitudeRef != null ? d.GPSLongitudeRef : d.gpsLongitudeRef);
                }
                var dateTime = EXIF.getTag(this, 'DateTime') || EXIF.getTag(this, 'DateTimeOriginal');
                var make = EXIF.getTag(this, 'Make');
                var model = EXIF.getTag(this, 'Model');
                var orientation = EXIF.getTag(this, 'Orientation');
                var latlng = null;
                if (lat && lon && latRef && lonRef) {
                    var latDecimal = convertDMSToDD(lat, latRef);
                    var lonDecimal = convertDMSToDD(lon, lonRef);
                    if (latDecimal !== null && lonDecimal !== null && Number.isFinite(latDecimal) && Number.isFinite(lonDecimal)) {
                        latlng = { lat: latDecimal, lng: lonDecimal };
                    }
                }
                var exifData = {
                    dateTime: dateTime || null,
                    make: make || null,
                    model: model || null,
                    orientation: orientation || null,
                    hasGPS: !!latlng,
                    gpsLat: latlng ? latlng.lat : null,
                    gpsLng: latlng ? latlng.lng : null,
                    gpsSource: latlng ? 'EXIF' : 'None',
                };
                resolve({
                    file: file,
                    gps: latlng,
                    exifData: exifData,
                    uploadManifest: buildPhotoUploadManifest(
                        file,
                        latlng,
                        exifData,
                        serializeExifTagsForManifest(this.exifdata || {}),
                        !!(latlng || dateTime || make || model)
                    ),
                });
            });
        } catch (e) {
            clearTimeout(timeout);
            const empty = emptyPhotoExifData();
            resolve({
                file: file,
                gps: null,
                exifData: empty,
                uploadManifest: buildPhotoUploadManifest(file, null, empty, null, false),
            });
        }
    });
}

function readExifFromOneFile(file) {
    if (isHeicOrHeifFile(file)) {
        return readExifFromOneFileViaExifr(file);
    }
    return readExifFromOneFileViaExifJs(file);
}

// Upload photos using EXIF/GPS captured at selection time (so tagging works even if file is stripped later).
async function handlePhotoFilesWithCachedExif(itemsWithExif) {
    const items = itemsWithExif;
    if (!items || items.length === 0) return;

    const totalFiles = items.length;

    const batchId = 'batch-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    currentBatchId = batchId;
    const currentOrgId = resolveCurrentOrgId();
    photoBatches.push({
        id: batchId,
        name: null,
        photoIds: [],
        createdAt: new Date().toISOString(),
        organizationId: currentOrgId
    });
    savePhotoBatches();

    var uploadedOk = 0;
    var uploadedNoGps = 0;
    window._pendingNoGpsAssociationFileIds = [];
    var heicCount = 0;
    for (var h = 0; h < items.length; h++) {
        if (isHeicOrHeifFile(items[h].file)) heicCount++;
    }
    beginPhotoHeicConversionBatch(heicCount);

    if (!window.authModule || !window.authModule.isAuthenticated()) {
        endPhotoHeicConversionBatch();
        await appAlert('You must be logged in to upload photos.');
        currentBatchId = null;
        return;
    }

    try {
    const pipelineResult = await runGalleryPhotoUploadPipeline(items);
    uploadedOk = pipelineResult.uploadedOk;
    uploadedNoGps = pipelineResult.uploadedNoGps;
    } finally {
        endPhotoHeicConversionBatch();
    }

    if (uploadedOk > 0) {
        showPhotoUploadSuccess(uploadedOk, uploadedNoGps);
    } else {
        hidePhotoUploadStatus();
    }
    if (
        window.photoTicketAssociationModule &&
        typeof window.photoTicketAssociationModule.flushPendingNoGpsAssociationPrompt === 'function'
    ) {
        await window.photoTicketAssociationModule.flushPendingNoGpsAssociationPrompt();
    }
    currentBatchId = null;
}

// Main photo upload initialization function (legacy — redirects to unified file picker)
function initPhotoUpload() {
    openUnifiedMapFilePicker();
}

// Parse EXIF data from photo
function parsePhotoExif(file, onComplete, onNoGPS) {
    // Check if EXIF library is available
    if (typeof EXIF === 'undefined') {
        console.error('EXIF library not loaded');
        // Fallback: save without GPS
        uploadPhotoWithoutExif(file, null, null, onComplete, onNoGPS);
        return;
    }
    
    let completed = false;
    let timeoutId = null;
    function done() {
        if (completed) return;
        completed = true;
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
    }
    // On mobile, EXIF.getData can hang (e.g. HEIC, large files); skip EXIF and upload after 5s so uploads don't linger
    const EXIF_TIMEOUT_MS = 5000;
    timeoutId = setTimeout(function() {
        if (completed) return;
        completed = true;
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
        uploadPhotoWithoutExif(file, null, null, onComplete, onNoGPS);
    }, EXIF_TIMEOUT_MS);

    try {
        EXIF.getData(file, function() {
            if (completed) return;
            done();
            // Get GPS coordinates from EXIF (tag names per EXIF spec)
            let lat = EXIF.getTag(this, 'GPSLatitude');
            let latRef = EXIF.getTag(this, 'GPSLatitudeRef');
            let lon = EXIF.getTag(this, 'GPSLongitude');
            let lonRef = EXIF.getTag(this, 'GPSLongitudeRef');
            // Fallback: some sources expose with different casing or on exifdata
            if ((!lat || !lon) && this.exifdata) {
                const d = this.exifdata;
                lat = lat || d.GPSLatitude || d.gpsLatitude;
                latRef = latRef != null ? latRef : (d.GPSLatitudeRef != null ? d.GPSLatitudeRef : d.gpsLatitudeRef);
                lon = lon || d.GPSLongitude || d.gpsLongitude;
                lonRef = lonRef != null ? lonRef : (d.GPSLongitudeRef != null ? d.GPSLongitudeRef : d.gpsLongitudeRef);
            }
            
            // Get other useful EXIF data
            const dateTime = EXIF.getTag(this, 'DateTime') || EXIF.getTag(this, 'DateTimeOriginal');
            const make = EXIF.getTag(this, 'Make');
            const model = EXIF.getTag(this, 'Model');
            const orientation = EXIF.getTag(this, 'Orientation');
            
            let latlng = null;
            
            // Convert GPS coordinates if available
            if (lat && lon && latRef && lonRef) {
                const latDecimal = convertDMSToDD(lat, latRef);
                const lonDecimal = convertDMSToDD(lon, lonRef);
                
                if (latDecimal !== null && lonDecimal !== null && Number.isFinite(latDecimal) && Number.isFinite(lonDecimal)) {
                    latlng = L.latLng(latDecimal, lonDecimal);
                }
            }
            
            // Build exifData object from EXIF tags
            const exifData = {
                dateTime: dateTime || null,
                make: make || null,
                model: model || null,
                orientation: orientation || null,
                hasGPS: !!(lat && lon && latRef && lonRef),
                gpsLat: latlng ? latlng.lat : null,
                gpsLng: latlng ? latlng.lng : null,
                gpsSource: latlng ? 'EXIF' : 'None'
            };
            
            // Upload file to backend first, then process
            uploadPhotoToBackend(file, latlng, exifData, onComplete, onNoGPS);
        });
    } catch (err) {
        if (!completed) {
            done();
            uploadPhotoWithoutExif(file, null, null, onComplete, onNoGPS);
        }
    }
}

// Upload photo to backend. Returns true if the server accepted and the photo was recorded.
// Optional batchPin: { batchId, batchName } — used when uploads continue after gallery batch id is cleared (in-page camera).
// uploadManifest: EXIF snapshot from the original file before HEIC conversion / resize.
async function uploadPhotoToBackend(file, latlng, exifData, onComplete, onNoGPS, batchPin, uploadManifest) {
    if (!window.authModule || !window.authModule.isAuthenticated()) {
        await appAlert('You must be logged in to upload photos.');
        if (typeof onComplete === 'function') onComplete();
        return false;
    }

    const item = {
        file: file,
        gps: latlng ? { lat: latlng.lat, lng: latlng.lng } : null,
        exifData: exifData || emptyPhotoExifData(),
        uploadManifest: uploadManifest || null,
    };
    const bundle = await preparePhotoUploadBundle(item);
    if (!bundle) {
        if (typeof onComplete === 'function') onComplete();
        return false;
    }
    return uploadPreparedPhotoBundle(bundle, onComplete, onNoGPS, batchPin);
}

/** Upload a photo that was already converted and resized. */
async function uploadPreparedPhotoBundle(bundle, onComplete, onNoGPS, batchPin) {
    if (!window.authModule || !window.authModule.isAuthenticated()) {
        await appAlert('You must be logged in to upload photos.');
        if (typeof onComplete === 'function') onComplete();
        return false;
    }
    if (!bundle || !bundle.file) {
        if (typeof onComplete === 'function') onComplete();
        return false;
    }

    const offline = window.offlineModule && window.offlineModule.isOnline && !window.offlineModule.isOnline();
    if (offline && window.offlinePhotos) {
        const originalFileName = bundle.originalFileName || (bundle.file.name ? bundle.file.name : 'photo');
        const latlng = bundle.latlng || null;
        const clientPhotoId =
            window.offlinePhotos.newClientPhotoId && window.offlinePhotos.newClientPhotoId();
        const localPhotoRecord = {
            id: 'photo-offline-' + (clientPhotoId || Date.now()),
            offlineClientPhotoId: clientPhotoId,
            offlinePendingUpload: true,
            fileName: originalFileName,
            originalFileName: originalFileName,
            organizationId: resolveCurrentOrgId(),
            createdAt: new Date().toISOString(),
            latlng: latlng,
            exifData: bundle.exifData || emptyPhotoExifData(),
            uploadedBy: resolveCurrentUserDisplayName(),
        };
        await registerOfflinePendingPhoto(localPhotoRecord, bundle);
        const queued = await window.offlinePhotos.enqueueOfflinePhotoUpload(bundle, localPhotoRecord);
        if (!queued && typeof window.appAlert === 'function') {
            await window.appAlert('Could not save photo for offline upload.');
        }
        if (typeof onComplete === 'function') onComplete();
        return !!queued;
    }

    const file = bundle.file;
    const originalFileName = bundle.originalFileName || (file.name ? file.name : 'photo');
    const latlng = bundle.latlng || null;
    const exifData = bundle.exifData || emptyPhotoExifData();
    const manifest = bundle.uploadManifest && typeof bundle.uploadManifest === 'object' ? bundle.uploadManifest : null;

    try {
        // Create FormData for file upload
        const formData = new FormData();
        formData.append('file', file);
        formData.append('fileType', 'photo');
        
        const pinId = batchPin && batchPin.batchId != null && batchPin.batchId !== '' ? batchPin.batchId : null;
        const pinName = batchPin && batchPin.batchName != null && batchPin.batchName !== '' ? batchPin.batchName : null;

        // Include metadata (EXIF data, GPS if available, upload batch for grouping on all devices)
        const metadata = {
            exif: exifData || {},
            hasGPS: latlng !== null,
            originalFileName: originalFileName,
        };
        if (manifest) {
            metadata.uploadManifest = {
                originalFileName: manifest.originalFileName,
                originalMimeType: manifest.originalMimeType,
                sourceFormat: manifest.sourceFormat,
                readAt: manifest.readAt,
                exifReadOk: manifest.exifReadOk,
                exifTags: manifest.exifTags,
            };
        }
        const batchIdMeta = pinId || currentBatchId;
        if (batchIdMeta) {
            metadata.batchId = batchIdMeta;
            if (pinId && pinName) {
                metadata.batchName = pinName;
            } else {
                const b = photoBatches.find(x => x.id === batchIdMeta);
                if (b && b.name) metadata.batchName = b.name;
            }
        }
        if (latlng) {
            metadata.lat = latlng.lat;
            metadata.lng = latlng.lng;
        }
        if (exifData && Number.isFinite(exifData.gpsAccuracyMeters)) {
            metadata.gpsAccuracyMeters = exifData.gpsAccuracyMeters;
        }
        if (exifData && Number.isFinite(exifData.gpsHeadingDegrees)) {
            metadata.gpsHeadingDegrees = exifData.gpsHeadingDegrees;
            if (exifData.gpsHeadingSource) {
                metadata.gpsHeadingSource = exifData.gpsHeadingSource;
            }
        }
        const assocCtx = window.photoUploadAssociationContext;
        if (assocCtx && assocCtx.source === 'dirt' && assocCtx.ticketId != null) {
            metadata.associatedTicketId = Number(assocCtx.ticketId);
            metadata.associationSource = 'dirt';
            if (assocCtx.dirtEventId != null) metadata.dirtEventId = String(assocCtx.dirtEventId);
        } else if (
            exifData &&
            exifData.associatedTicketId != null &&
            Number.isFinite(Number(exifData.associatedTicketId))
        ) {
            metadata.associatedTicketId = Number(exifData.associatedTicketId);
        }
        if (exifData && exifData.stakeOfPhotoId != null) {
            metadata.stakeOfPhotoId = String(exifData.stakeOfPhotoId);
            if (Number.isFinite(exifData.stakeGhostOpacity)) {
                metadata.stakeGhostOpacity = exifData.stakeGhostOpacity;
            }
        }
        formData.append('metadata', JSON.stringify(metadata));
        const currentOrgId = resolveCurrentOrgId();
        if (currentOrgId) formData.append('organizationId', String(currentOrgId));

        const canvasUtils = window.photoCanvasUtils;
        const MAP_THUMB_MAX_EDGE = 400;
        if (canvasUtils && typeof canvasUtils.generateJpegThumbnailBlob === 'function') {
            try {
                const thumbBlob = await canvasUtils.generateJpegThumbnailBlob(file, MAP_THUMB_MAX_EDGE);
                if (thumbBlob) {
                    formData.append('thumbnail', thumbBlob, 'thumb.jpg');
                }
            } catch (thumbErr) {
                console.warn('Map thumbnail generation failed:', thumbErr);
            }
        }
        
        // Upload to backend
        const response = await fetch(`${window.authModule.API_BASE}/data/media`, {
            method: 'POST',
            headers: (window.authModule && window.authModule.getAuthHeaders) ? window.authModule.getAuthHeaders() : { 'Authorization': 'Bearer ' + (localStorage.getItem('authToken') || '') },
            body: formData
        });
        
        if (!response.ok) {
            throw new Error(`Upload failed: ${response.statusText}`);
        }
        
        const result = await response.json();

        if (assocCtx && assocCtx.source === 'dirt' && result.id != null && typeof assocCtx.onPhotoAssociated === 'function') {
            assocCtx.onPhotoAssociated(Number(result.id));
        }
        
        // Get the file URL from backend
        const baseUrl = (window.authModule && window.authModule.getApiBaseForMedia)
            ? window.authModule.getApiBaseForMedia()
            : (window.API_BASE_URL || window.location.origin);
        // Backend returns url as "/api/data/media/:id/file", prepend base URL
        const fileUrl = result.url ? `${baseUrl}${result.url}` : null;
        const thumbnailUrl = result.thumbnailUrl ? `${baseUrl}${result.thumbnailUrl}` : null;
        
        if (!fileUrl) {
            throw new Error('Failed to get file URL from backend');
        }
        
        if (latlng) {
            // Photo has GPS data - validate to avoid LatLng(NaN, NaN) from bad EXIF
            const lat = Number(latlng.lat);
            const lng = Number(latlng.lng);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                const validLatlng = L.latLng(lat, lng);
                const uploader = result.uploadedBy || resolveCurrentUserDisplayName();
                addPhotoMarker(validLatlng, fileUrl, originalFileName, exifData, result.id, undefined, uploader, thumbnailUrl);
                const map = window.map;
                if (map) {
                    map.setView(validLatlng, Math.max(map.getZoom(), 15));
                }
            } else {
                savePhotoWithoutLocation(fileUrl, originalFileName, exifData, result.id, undefined, result.uploadedBy || resolveCurrentUserDisplayName(), thumbnailUrl);
                if (
                    window.photoTicketAssociationModule &&
                    typeof window.photoTicketAssociationModule.handlePostUploadNoGps === 'function'
                ) {
                    await window.photoTicketAssociationModule.handlePostUploadNoGps(result.id, false);
                } else if (typeof onNoGPS === 'function') {
                    onNoGPS(result.id);
                }
            }
            if (typeof onComplete === 'function') onComplete();
            return true;
        } else {
            // No GPS data - save without location (user can associate to a ticket or tag later in Data Management)
            savePhotoWithoutLocation(fileUrl, originalFileName, exifData, result.id, undefined, result.uploadedBy || resolveCurrentUserDisplayName(), thumbnailUrl);
            if (
                window.photoTicketAssociationModule &&
                typeof window.photoTicketAssociationModule.handlePostUploadNoGps === 'function'
            ) {
                await window.photoTicketAssociationModule.handlePostUploadNoGps(result.id, false);
            } else if (typeof onNoGPS === 'function') {
                onNoGPS(result.id);
            }
            if (typeof onComplete === 'function') onComplete();
            return true;
        }
    } catch (error) {
        console.error('Error uploading photo to backend:', error);
        showPhotoUploadError(error.message || 'Network error');
        if (typeof onComplete === 'function') onComplete();
        return false;
    }
}

// Convert DMS (Degrees, Minutes, Seconds) to Decimal Degrees
// EXIF can return DMS as numbers or as rationals { numerator, denominator }
function dmsToNumber(component) {
    if (component == null) return NaN;
    if (typeof component === 'number' && Number.isFinite(component)) return component;
    if (typeof component === 'object' && component != null && 'numerator' in component && 'denominator' in component) {
        const d = component.denominator;
        return d && Number.isFinite(component.numerator) && Number.isFinite(d) ? component.numerator / d : NaN;
    }
    const n = Number(component);
    return Number.isFinite(n) ? n : NaN;
}

function convertDMSToDD(dms, ref) {
    if (!dms || !Array.isArray(dms) || dms.length !== 3) {
        return null;
    }
    
    const d0 = dmsToNumber(dms[0]);
    const d1 = dmsToNumber(dms[1]);
    const d2 = dmsToNumber(dms[2]);
    if (Number.isNaN(d0) || Number.isNaN(d1) || Number.isNaN(d2)) {
        return null;
    }
    
    let dd = d0 + d1 / 60 + d2 / (60 * 60);
    const refStr = (ref != null && typeof ref === 'string') ? ref : (Array.isArray(ref) ? ref[0] : String(ref || ''));
    if (refStr === 'S' || refStr === 'W') {
        dd = dd * -1;
    }
    
    return (typeof dd === 'number' && Number.isFinite(dd)) ? dd : null;
}

// Get GPS from an image file (for use by document uploader). Returns Promise<{lat,lng}|null>.
function getGpsFromImageFile(file) {
    return new Promise((resolve) => {
        if (typeof EXIF === 'undefined') {
            resolve(null);
            return;
        }
        const isImage = file.type && file.type.startsWith('image/');
        if (!isImage) {
            resolve(null);
            return;
        }
        const timeout = setTimeout(() => resolve(null), 5000);
        try {
            EXIF.getData(file, function() {
                clearTimeout(timeout);
                let lat = EXIF.getTag(this, 'GPSLatitude');
                let latRef = EXIF.getTag(this, 'GPSLatitudeRef');
                let lon = EXIF.getTag(this, 'GPSLongitude');
                let lonRef = EXIF.getTag(this, 'GPSLongitudeRef');
                if ((!lat || !lon) && this.exifdata) {
                    const d = this.exifdata;
                    lat = lat || d.GPSLatitude || d.gpsLatitude;
                    latRef = latRef != null ? latRef : (d.GPSLatitudeRef != null ? d.GPSLatitudeRef : d.gpsLatitudeRef);
                    lon = lon || d.GPSLongitude || d.gpsLongitude;
                    lonRef = lonRef != null ? lonRef : (d.GPSLongitudeRef != null ? d.GPSLongitudeRef : d.gpsLongitudeRef);
                }
                if (!lat || !lon || !latRef || !lonRef) {
                    resolve(null);
                    return;
                }
                const latDecimal = convertDMSToDD(lat, latRef);
                const lonDecimal = convertDMSToDD(lon, lonRef);
                if (latDecimal != null && lonDecimal != null && Number.isFinite(latDecimal) && Number.isFinite(lonDecimal)) {
                    resolve({ lat: latDecimal, lng: lonDecimal });
                } else {
                    resolve(null);
                }
            });
        } catch (err) {
            clearTimeout(timeout);
            resolve(null);
        }
    });
}

// Save photo without location (user can tag later in Data Management)
async function registerOfflinePendingPhoto(localPhotoRecord, bundle) {
    const currentOrgId = resolveCurrentOrgId();
    const latlng = localPhotoRecord && localPhotoRecord.latlng;
    const photoData = {
        id: localPhotoRecord.id,
        offlineClientPhotoId: localPhotoRecord.offlineClientPhotoId,
        offlinePendingUpload: true,
        latlng:
            latlng && Number.isFinite(latlng.lat) && Number.isFinite(latlng.lng)
                ? { lat: latlng.lat, lng: latlng.lng }
                : null,
        imageUrl: null,
        thumbnailUrl: null,
        fileName: localPhotoRecord.fileName,
        originalFileName: localPhotoRecord.originalFileName || localPhotoRecord.fileName,
        exifData: localPhotoRecord.exifData || emptyPhotoExifData(),
        createdAt: localPhotoRecord.createdAt || new Date().toISOString(),
        batchId: currentBatchId,
        marker: null,
        organizationId: currentOrgId,
        fileId: null,
        note: '',
        uploadedBy: localPhotoRecord.uploadedBy || resolveCurrentUserDisplayName(),
        noteLastEditedBy: '',
        noteLastEditedAt: '',
    };
    if (bundle && bundle.file) {
        const clientPhotoId = localPhotoRecord.offlineClientPhotoId;
        if (
            clientPhotoId &&
            window.offlinePhotos &&
            typeof window.offlinePhotos.generateAndCacheOfflineThumbnail === 'function'
        ) {
            const thumbBlob = await window.offlinePhotos.generateAndCacheOfflineThumbnail(
                bundle.file,
                clientPhotoId
            );
            if (thumbBlob) {
                photoData.thumbnailUrl = URL.createObjectURL(thumbBlob);
                photoData._offlineThumbPreview = true;
            }
        }
        photoData.imageUrl = URL.createObjectURL(bundle.file);
        photoData._offlineBlobPreview = true;
    }
    savedPhotos.push(photoData);
    if (currentBatchId) {
        const batch = photoBatches.find((b) => b.id === currentBatchId);
        if (batch) {
            batch.photoIds.push(photoData.id);
            savePhotoBatches();
        }
    }
    savePhotos();
    if (photoData.latlng) {
        attachMapMarkerForPhoto(photoData);
    }
    updatePhotosLayerControl();
    if (window.refreshDataWindow) window.refreshDataWindow();
}

function attachMapMarkerForPhoto(photoData) {
    const map = window.map;
    if (!map || !photoData || !photoData.latlng) return;
    const lat = Number(photoData.latlng.lat);
    const lng = Number(photoData.latlng.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const validLatlng = L.latLng(lat, lng);

    const passesRecent =
        window.photoTicketAssociationModule &&
        typeof window.photoTicketAssociationModule.photoMatchesRecentWindow === 'function'
            ? window.photoTicketAssociationModule.photoMatchesRecentWindow(photoData)
            : true;
    if (!passesRecent) return;

        const photoIcon = L.divIcon({
            className: getPhotoMapMarkerClassName(photoData),
            html: getPhotoMapMarkerIconHtml(photoData),
            iconSize: [32, 32],
            iconAnchor: [16, 32],
            popupAnchor: [0, -32],
        });
        const marker = L.marker(validLatlng, { icon: photoIcon, photoId: photoData.id });
    photoData.marker = marker;
    if (!photosLayerGroup) initPhotosLayer();
    const pointLayer = getPhotosPointMarkerLayer();
    if (pointLayer) {
        marker.addTo(pointLayer);
    } else {
        marker.addTo(map);
    }
    marker.bindPopup(buildPhotoMapPopupHtml(photoData), { autoPan: false });
    marker.on('popupopen', function () {
        const el = this.getPopup().getElement();
        if (el && window.photosModule && window.photosModule.setServerPhotoImageSources) {
            window.photosModule.setServerPhotoImageSources(el);
        }
        bindPhotoPopupNoteButton(el);
        if (window.photosModule && window.photosModule.centerMapOnPhotoPopup) {
            window.photosModule.centerMapOnPhotoPopup(this);
        }
    });
    if (window.photosModule && window.photosModule.wirePhotoMapMarkerLeafletMobile) {
        window.photosModule.wirePhotoMapMarkerLeafletMobile(marker);
    }
}

function savePhotoWithoutLocation(imageUrl, fileName, exifData, fileId, note, uploadedBy, thumbnailUrl) {
    const currentOrgId = resolveCurrentOrgId();
    const photoData = {
        id: `photo-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        latlng: null,
        imageUrl: imageUrl,
        thumbnailUrl: thumbnailUrl || null,
        fileName: fileName,
        originalFileName: fileName,
        exifData: exifData || { gpsSource: 'None', hasGPS: false },
        createdAt: new Date().toISOString(),
        batchId: currentBatchId,
        marker: null,
        organizationId: currentOrgId,
        fileId: fileId,
        note: note || '',
        uploadedBy: uploadedBy || '',
        noteLastEditedBy: '',
        noteLastEditedAt: ''
    };
    if (window.photoStakeUtils && typeof window.photoStakeUtils.applyStakeFieldsFromExif === 'function') {
        window.photoStakeUtils.applyStakeFieldsFromExif(photoData, exifData);
    }
    
    // Add to saved photos
    savedPhotos.push(photoData);
    savePhotos();
    
    // Update batch with photo ID
    if (currentBatchId) {
        const batch = photoBatches.find(b => b.id === currentBatchId);
        if (batch) {
            batch.photoIds.push(photoData.id);
            savePhotoBatches();
        }
    }

    if (window.ticketsModule && typeof window.ticketsModule.refreshTicketUiAfterPhotoChange === 'function') {
        window.ticketsModule.refreshTicketUiAfterPhotoChange(photoData, 'photo-upload');
    }
    
    // Refresh data window if open
    if (window.refreshDataWindow) {
        window.refreshDataWindow();
    }
}

// Upload photo without EXIF GPS data - now just saves without location (user can tag later)
function uploadPhotoWithoutExif(file, imageUrl, exifData, onComplete, onNoGPS) {
    // Always upload to backend
    uploadPhotoToBackend(file, null, exifData, onComplete, onNoGPS);
}

// Add photo marker to map
function addPhotoMarker(latlng, imageUrl, fileName, exifData, fileId, note, uploadedBy, thumbnailUrl) {
    const map = window.map;
    if (!map) return;
    
    const lat = Number(latlng && latlng.lat);
    const lng = Number(latlng && latlng.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        savePhotoWithoutLocation(imageUrl, fileName, exifData, fileId, note, uploadedBy, thumbnailUrl);
        return;
    }
    const validLatlng = L.latLng(lat, lng);
    
    const currentOrgId = resolveCurrentOrgId();
    const photoId = `photo-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const photoData = {
        id: photoId,
        latlng: {
            lat: validLatlng.lat,
            lng: validLatlng.lng
        },
        imageUrl: imageUrl,
        thumbnailUrl: thumbnailUrl || null,
        fileName: fileName,
        originalFileName: fileName,
        exifData: exifData || {},
        createdAt: new Date().toISOString(),
        batchId: currentBatchId,
        marker: null,
        organizationId: currentOrgId,
        fileId: fileId,
        note: note || '',
        uploadedBy: uploadedBy || '',
        noteLastEditedBy: '',
        noteLastEditedAt: ''
    };

    if (window.photoStakeUtils && typeof window.photoStakeUtils.applyStakeFieldsFromExif === 'function') {
        window.photoStakeUtils.applyStakeFieldsFromExif(photoData, exifData);
    }

    const passesRecent =
        window.photoTicketAssociationModule &&
        typeof window.photoTicketAssociationModule.photoMatchesRecentWindow === 'function'
            ? window.photoTicketAssociationModule.photoMatchesRecentWindow(photoData)
            : true;

    const useViewportPhotoLoader =
        window.photoMapLoaderModule &&
        !(window.offlineModule && window.offlineModule.isOnline && !window.offlineModule.isOnline());

    if (passesRecent && !useViewportPhotoLoader) {
        const photoIcon = L.divIcon({
            className: getPhotoMapMarkerClassName(photoData),
            html: getPhotoMapMarkerIconHtml(photoData),
            iconSize: [32, 32],
            iconAnchor: [16, 32],
            popupAnchor: [0, -32]
        });

        const marker = L.marker(validLatlng, { icon: photoIcon, photoId: photoId });
        photoData.marker = marker;

        if (!photosLayerGroup) {
            initPhotosLayer();
        }

        const pointLayer = getPhotosPointMarkerLayer();
        if (pointLayer) {
            marker.addTo(pointLayer);
        } else {
            marker.addTo(map);
        }

        marker.bindPopup(buildPhotoMapPopupHtml(photoData), { autoPan: false });
        marker.on('popupopen', function () {
            const el = this.getPopup().getElement();
            if (el && window.photosModule && window.photosModule.setServerPhotoImageSources) {
                window.photosModule.setServerPhotoImageSources(el);
            }
            bindPhotoPopupNoteButton(el);
            if (window.photosModule && window.photosModule.centerMapOnPhotoPopup) {
                window.photosModule.centerMapOnPhotoPopup(this);
            }
        });
        if (window.photosModule && window.photosModule.wirePhotoMapMarkerLeafletMobile) {
            window.photosModule.wirePhotoMapMarkerLeafletMobile(marker);
        }
    }
    
    // Store photo data in savedPhotos array
    savedPhotos.push(photoData);
    
    // Add photo to current batch if batch exists
    if (currentBatchId) {
        const batch = photoBatches.find(b => b.id === currentBatchId);
        if (batch) {
            batch.photoIds.push(photoData.id);
            savePhotoBatches();
        }
    }
    
    savePhotos();

    if (useViewportPhotoLoader) {
        if (typeof window.photoMapLoaderModule.invalidatePhotoMapCache === 'function') {
            window.photoMapLoaderModule.invalidatePhotoMapCache();
        }
        if (typeof window.photoMapLoaderModule.scheduleFetchPhotoMapForViewport === 'function') {
            window.photoMapLoaderModule.scheduleFetchPhotoMapForViewport(true);
        }
    }
    
    // Update photos layer in layer control
    updatePhotosLayerControl();
    
    // Also store in window.photoMarkers for backward compatibility
    if (!window.photoMarkers) {
        window.photoMarkers = [];
    }
    window.photoMarkers.push(photoData);

    if (window.ticketsModule && typeof window.ticketsModule.refreshTicketUiAfterPhotoChange === 'function') {
        window.ticketsModule.refreshTicketUiAfterPhotoChange(photoData, 'photo-upload');
    } else if (window.ticketsModule && typeof window.ticketsModule.refreshOpenTicketPopupAfterPhotoChange === 'function') {
        window.ticketsModule.refreshOpenTicketPopupAfterPhotoChange({
            lat: validLatlng.lat,
            lng: validLatlng.lng,
            requirePointMatch: true,
        });
    }
    
    // Refresh data window if open
    if (window.refreshDataWindow) {
        window.refreshDataWindow();
    }
}

// Update photos layer control panel checkbox
function updatePhotosLayerControl() {
    const map = window.map;
    if (!map || !window.layerControlPanel) return;

    const publicCatalog =
        typeof window.isCurrentOrgPublicCatalogViewer === 'function' &&
        window.isCurrentOrgPublicCatalogViewer();
    const toggles = window.mapOverlayTogglesModule;

    if (publicCatalog) {
        if (toggles) toggles.removeMapOverlayToggle('photos');
        if (photosLayerGroup) syncPhotosLayerForZoom();
        return;
    }

    if (!photosLayerGroup) {
        initPhotosLayer();
    }

    if (toggles) {
        toggles.createMapOverlayToggle({
            id: 'photos',
            label: 'Photos',
            getActive: function () {
                return !!photosLayerUserEnabled;
            },
            onToggle: function (active) {
                photosLayerUserEnabled = !!active;
                syncPhotosLayerForZoom();
                toggles.syncMapOverlayToggle('photos', photosLayerUserEnabled);
                if (
                    window.photoMapLoaderModule &&
                    typeof window.photoMapLoaderModule.notifyPhotosLayerToggled === 'function'
                ) {
                    window.photoMapLoaderModule.notifyPhotosLayerToggled(!!active);
                }
            },
        });
        toggles.syncMapOverlayToggle('photos', !!photosLayerUserEnabled);
    }

    if (photosLayerGroup) {
        syncPhotosLayerForZoom();
    }
}

// Zoom to photos layer
function zoomToPhotosLayer() {
    const map = window.map;
    if (!map || !photosLayerGroup || !savedPhotos || savedPhotos.length === 0) return;

    // Get bounds from the layer group
    try {
        const bounds = photosLayerGroup.getBounds();
        if (bounds && bounds.isValid && bounds.isValid()) {
            map.fitBounds(bounds, { padding: [50, 50] });
            syncPhotosLayerForZoom();
            return;
        }
    } catch (error) {
        // Fallback below
    }
    
    // Fallback: calculate bounds from photo locations
    const allCoords = [];
    savedPhotos.forEach(photo => {
        if (photo.latlng) {
            allCoords.push([photo.latlng.lat, photo.latlng.lng]);
        }
    });
    
    if (allCoords.length > 0) {
        const bounds = L.latLngBounds(allCoords);
        map.fitBounds(bounds, { padding: [50, 50] });
    }

    syncPhotosLayerForZoom();
}

// Cancel photo upload mode
function cancelPhotoUpload() {
    photoUploadMode = false;
    
    const map = window.map;
    if (photoUploadHandler && map) {
        map.off('click', photoUploadHandler);
        photoUploadHandler = null;
    }
    
    // Reset cursor
    if (map) {
        map.getContainer().style.cursor = '';
    }
    
    // Update button state
    if (window.annotationsModule && window.annotationsModule.updateDrawingButtons) {
        window.annotationsModule.updateDrawingButtons();
    }
}

function syncPhotoViewerTagsBar(photo) {
    const controls = document.querySelector('.photo-viewer-controls');
    if (!controls) return;
    const bar = document.getElementById('photoViewerTagsBar');
    if (bar) bar.remove();

    let btn = document.getElementById('photoViewerEditDetailsBtn');
    if (!photo || photo.readOnly) {
        if (btn) btn.remove();
        return;
    }

    if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'photo-viewer-btn photo-viewer-edit-details-btn';
        btn.id = 'photoViewerEditDetailsBtn';
        controls.appendChild(btn);
    }

    btn.textContent = viewerTr('Notes and tags');
    btn.title = viewerTr('Notes and tags');
    btn.onclick = function () {
        if (window.photosModule && typeof window.photosModule.promptEditPhotoDetails === 'function') {
            window.photosModule.promptEditPhotoDetails(photo.id);
        }
    };
}

function clearPhotoViewerTagsBar() {
    const bar = document.getElementById('photoViewerTagsBar');
    if (bar) bar.remove();
    const btn = document.getElementById('photoViewerEditDetailsBtn');
    if (btn) btn.remove();
}

function clearPhotoViewerStampOverlay() {
    const el = document.getElementById('photoViewerStampOverlay');
    if (el) {
        el.hidden = true;
        el.innerHTML = '';
    }
}

/** @type {ReturnType<typeof window.photoMicromap.create>|null} */
let photoViewerMicromapHandle = null;

function photoViewerHasGps(photo) {
    if (!photo || typeof photo !== 'object') return false;
    const lat = Number(photo.latlng && photo.latlng.lat);
    const lng = Number(photo.latlng && photo.latlng.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return true;
    const exif = photo.exifData;
    if (!exif) return false;
    const elat = Number(exif.gpsLat);
    const elng = Number(exif.gpsLng);
    return Number.isFinite(elat) && Number.isFinite(elng);
}

function getPhotoMicromapFix(photo) {
    if (!photo || typeof photo !== 'object') return null;
    let lat = Number(photo.latlng && photo.latlng.lat);
    let lng = Number(photo.latlng && photo.latlng.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        const exif = photo.exifData;
        if (exif) {
            lat = Number(exif.gpsLat);
            lng = Number(exif.gpsLng);
        }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const utils = window.photoCanvasUtils;
    const heading =
        utils && typeof utils.photoHasHeading === 'function' && utils.photoHasHeading(photo)
            ? utils.getPhotoHeadingDegrees(photo)
            : null;
    const accuracy =
        utils && typeof utils.getPhotoGpsAccuracyMeters === 'function'
            ? utils.getPhotoGpsAccuracyMeters(photo)
            : null;

    return {
        lat: lat,
        lng: lng,
        heading: heading,
        accuracy: accuracy,
    };
}

function clearPhotoViewerMicromap() {
    if (photoViewerMicromapHandle) {
        photoViewerMicromapHandle.destroy();
        photoViewerMicromapHandle = null;
    }
    const wrap = document.getElementById('photoViewerMicromap');
    if (wrap) {
        wrap.hidden = true;
        wrap.setAttribute('aria-hidden', 'true');
        wrap.classList.remove('photo-viewer-micromap--raised');
    }
}

function syncPhotoViewerMicromapOffset() {
    const wrap = document.getElementById('photoViewerMicromap');
    const bottomLeft = document.getElementById('photoViewerBottomLeft');
    if (!wrap) return;
    const isMobileStakeLayout =
        typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches;
    const raised = isMobileStakeLayout && !!(bottomLeft && !bottomLeft.hidden);
    wrap.classList.toggle('photo-viewer-micromap--raised', raised);
    if (photoViewerMicromapHandle && typeof photoViewerMicromapHandle.invalidateSize === 'function') {
        photoViewerMicromapHandle.invalidateSize();
    }
}

function syncPhotoViewerMicromap(photo) {
    const wrap = document.getElementById('photoViewerMicromap');
    const mapEl = document.getElementById('photoViewerMicromapMap');
    if (!wrap || !mapEl) return;

    if (photoViewerCompareActive || !photoViewerHasGps(photo)) {
        clearPhotoViewerMicromap();
        return;
    }

    const fix = getPhotoMicromapFix(photo);
    if (!fix) {
        clearPhotoViewerMicromap();
        return;
    }

    syncPhotoViewerMicromapOffset();

    const micromap = window.photoMicromap;
    if (!micromap || typeof micromap.create !== 'function' || typeof L === 'undefined') {
        wrap.hidden = true;
        return;
    }

    wrap.hidden = false;
    wrap.removeAttribute('hidden');
    wrap.setAttribute('aria-hidden', 'false');

    if (photoViewerMicromapHandle) {
        photoViewerMicromapHandle.update(fix);
        photoViewerMicromapHandle.invalidateSize();
    } else {
        photoViewerMicromapHandle = micromap.create(mapEl, fix);
    }
}

function escapePhotoViewerStampText(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function syncPhotoViewerStampOverlay(photo) {
    const container =
        document.getElementById('photoViewerBottomRight') ||
        document.getElementById('photoViewerImageContainer');
    if (!container) return;

    let el = document.getElementById('photoViewerStampOverlay');
    if (!el) {
        el = document.createElement('div');
        el.id = 'photoViewerStampOverlay';
        el.className = 'photo-viewer-stamp-overlay';
        el.setAttribute('aria-live', 'polite');
        container.appendChild(el);
    } else if (el.parentElement !== container) {
        container.appendChild(el);
    }

    const utils = window.photoCanvasUtils;
    const lines =
        utils && typeof utils.getPhotoStampOverlayLines === 'function'
            ? utils.getPhotoStampOverlayLines(photo)
            : [];

    if (!lines.length) {
        el.hidden = true;
        el.innerHTML = '';
        return;
    }

    el.hidden = false;
    el.innerHTML = lines
        .map(function (line) {
            return '<div class="photo-viewer-stamp-line">' + escapePhotoViewerStampText(line) + '</div>';
        })
        .join('');
}

window.syncPhotoViewerTagsBar = syncPhotoViewerTagsBar;

function getPhotoViewerMediaBaseUrl() {
    return window.authModule && window.authModule.getApiBaseForMedia
        ? window.authModule.getApiBaseForMedia()
        : window.API_BASE_URL || window.location.origin;
}

function normalizePhotoForViewerGallery(entry) {
    if (!entry) return null;
    if (typeof entry === 'string') {
        return { imageUrl: entry, fileName: 'Photo' };
    }
    const baseUrl = getPhotoViewerMediaBaseUrl();
    const rawFileId =
        entry.fileId != null
            ? Number(entry.fileId)
            : entry.id != null && Number.isFinite(Number(entry.id))
              ? Number(entry.id)
              : NaN;
    if (Number.isFinite(rawFileId) && rawFileId > 0) {
        const thumb = entry.thumbnailUrl
            ? entry.thumbnailUrl.startsWith('http')
                ? entry.thumbnailUrl
                : `${baseUrl}${entry.thumbnailUrl}`
            : null;
        return {
            id: entry.id != null ? entry.id : `gallery-photo-${rawFileId}`,
            fileId: rawFileId,
            fileName: entry.fileName || 'Photo',
            thumbnailUrl: thumb,
            imageUrl: entry.imageUrl || `${baseUrl}/api/data/media/${rawFileId}/file`,
            readOnly: !!entry.readOnly,
            createdAt: entry.createdAt,
            note: entry.note,
            exifData: entry.exifData,
            latlng: entry.latlng,
            associatedNoGps: !!entry.associatedNoGps,
        };
    }
    return entry;
}

function clearPhotoViewerGallery() {
    photoViewerGallery = null;
    updatePhotoViewerNavControls();
}

function setPhotoViewerGallery(items, index) {
    const normalized = (items || []).map(normalizePhotoForViewerGallery).filter(Boolean);
    if (normalized.length < 2) {
        clearPhotoViewerGallery();
        return;
    }
    let idx = Number(index);
    if (!Number.isFinite(idx)) idx = 0;
    if (idx < 0) idx = 0;
    if (idx >= normalized.length) idx = normalized.length - 1;
    photoViewerGallery = { items: normalized, index: idx };
    updatePhotoViewerNavControls();
}

function updatePhotoViewerNavControls() {
    const prev = document.getElementById('photoViewerPrevBtn');
    const next = document.getElementById('photoViewerNextBtn');
    const counter = document.getElementById('photoViewerGalleryCounter');
    const hasGallery = !!(photoViewerGallery && photoViewerGallery.items.length >= 2);
    if (prev) prev.hidden = !hasGallery;
    if (next) next.hidden = !hasGallery;
    if (counter) {
        counter.hidden = !hasGallery;
        if (hasGallery) {
            counter.textContent = `${photoViewerGallery.index + 1} / ${photoViewerGallery.items.length}`;
        }
    }
}

function stepPhotoViewerGallery(delta) {
    if (!photoViewerGallery || !photoViewerGallery.items.length) return;
    exitPhotoViewerCompare();
    const len = photoViewerGallery.items.length;
    let nextIndex = photoViewerGallery.index + Number(delta || 0);
    if (nextIndex < 0) nextIndex = len - 1;
    if (nextIndex >= len) nextIndex = 0;
    photoViewerGallery.index = nextIndex;
    const photo = photoViewerGallery.items[nextIndex];
    updatePhotoViewerNavControls();
    displayPhotoInViewer(photo, photo.fileName);
}

// Open photo viewer (imageUrlOrPhoto: URL string or photo object with fileId for tokenized load)
function openPhotoViewer(imageUrlOrPhoto, fileName, galleryContext) {
    if (
        galleryContext &&
        Array.isArray(galleryContext.gallery) &&
        galleryContext.gallery.length >= 2
    ) {
        setPhotoViewerGallery(galleryContext.gallery, galleryContext.galleryIndex);
        const current = photoViewerGallery.items[photoViewerGallery.index];
        displayPhotoInViewer(current, fileName || current.fileName);
        return;
    }
    clearPhotoViewerGallery();
    displayPhotoInViewer(imageUrlOrPhoto, fileName);
}

function displayPhotoInViewer(imageUrlOrPhoto, fileName) {
    const modal = document.getElementById('photoViewerModal');
    const image = document.getElementById('photoViewerImage');
    
    if (!modal || !image) return;
    exitPhotoViewerCompare();
    clearPhotoViewerTagsBar();
    clearPhotoViewerStampOverlay();
    clearPhotoViewerMicromap();
    photoViewerCurrentPhoto = null;
    const viewerOpenId = String(Date.now()) + ':' + Math.random().toString(36).slice(2);
    image.dataset.photoViewerOpenId = viewerOpenId;

    const ensureViewerStatus = () => {
        const container = document.getElementById('photoViewerImageContainer');
        if (!container) return null;
        container.classList.add('server-photo-image-status-host');
        let status = container.querySelector('.server-photo-image-status');
        if (!status) {
            status = document.createElement('span');
            status.className = 'server-photo-image-status';
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            status.innerHTML = '<span class="server-photo-image-spinner" aria-hidden="true"></span><span class="server-photo-image-fallback" aria-hidden="true" hidden>📷</span><span class="server-photo-image-status-text">Loading photo</span>';
            container.appendChild(status);
        }
        return status;
    };

    const setViewerImageState = (state) => {
        const status = ensureViewerStatus();
        if (!status) return;
        const spinner = status.querySelector('.server-photo-image-spinner');
        const fallback = status.querySelector('.server-photo-image-fallback');
        const text = status.querySelector('.server-photo-image-status-text');
        if (state === 'loading') {
            image.classList.add('server-photo-image-hidden');
            image.removeAttribute('src');
            status.hidden = false;
            if (spinner) spinner.hidden = false;
            if (fallback) fallback.hidden = true;
            if (text) text.textContent = 'Loading photo';
            return;
        }
        if (state === 'loaded') {
            image.classList.remove('server-photo-image-hidden');
            status.hidden = true;
            return;
        }
        image.classList.add('server-photo-image-hidden');
        image.removeAttribute('src');
        status.hidden = false;
        if (spinner) spinner.hidden = true;
        if (fallback) fallback.hidden = false;
        if (text) text.textContent = 'Photo unavailable';
    };

    const showViewerModal = () => {
        const dataWindow = document.getElementById('dataWindow');
        if (dataWindow && dataWindow.classList.contains('show')) {
            modal.dataset.dataWindowWasOpen = 'true';
            modal.dataset.dataWindowView = window.dataWindowModule ? window.dataWindowModule.currentDataView : 'photos';
        } else {
            modal.dataset.dataWindowWasOpen = 'false';
        }
        modal.classList.add('show');
        document.body.style.overflow = 'hidden';
        requestAnimationFrame(function () {
            if (photoViewerMicromapHandle && typeof photoViewerMicromapHandle.invalidateSize === 'function') {
                photoViewerMicromapHandle.invalidateSize();
            }
            if (window.photoMicromap && typeof window.photoMicromap.scheduleInvalidateSize === 'function' && photoViewerMicromapHandle) {
                window.photoMicromap.scheduleInvalidateSize(photoViewerMicromapHandle.map);
            }
        });
    };

    const setViewerAltAndReset = (name) => {
        const altBase = name != null && String(name).trim() !== '' ? String(name) : 'Photo';
        image.alt =
            typeof window.truncateImageNameForDisplay === 'function'
                ? window.truncateImageNameForDisplay(altBase) || 'Photo'
                : altBase.length > 10
                  ? altBase.slice(0, 10) + '...'
                  : altBase;
        photoViewerZoom = 1;
        photoViewerPanX = 0;
        photoViewerPanY = 0;
        updatePhotoViewerTransform();
    };
    
    const applyUrl = (url, displayName) => {
        if (image.dataset.photoViewerOpenId !== viewerOpenId) return;
        setViewerAltAndReset(displayName);
        showViewerModal();
        if (!url) {
            setViewerImageState('unavailable');
            return;
        }
        const requestId = String(Date.now()) + ':' + Math.random().toString(36).slice(2);
        image.dataset.photoViewerRequestId = requestId;
        image.onload = () => {
            if (image.dataset.photoViewerOpenId !== viewerOpenId || image.dataset.photoViewerRequestId !== requestId) return;
            setViewerImageState('loaded');
        };
        image.onerror = () => {
            if (image.dataset.photoViewerOpenId !== viewerOpenId || image.dataset.photoViewerRequestId !== requestId) return;
            setViewerImageState('unavailable');
        };
        setViewerImageState('loading');
        image.src = url;
    };

    if (typeof imageUrlOrPhoto === 'object' && imageUrlOrPhoto != null && (imageUrlOrPhoto.fileId || imageUrlOrPhoto.id)) {
        const photo = imageUrlOrPhoto;
        const name = fileName || photo.fileName;
        modal.dataset.currentPhotoId = photo.id != null ? String(photo.id) : '';
        syncPhotoViewerMatchShotButton(photo);
        syncPhotoViewerCompareButton(photo);
        syncPhotoViewerTagsBar(photo);
        syncPhotoViewerStampOverlay(photo);
        photoViewerCurrentPhoto = photo;
        syncPhotoViewerMicromap(photo);
        if (photo.fileId) {
            setViewerAltAndReset(name);
            showViewerModal();
            setViewerImageState('loading');
            const resolveViewerUrl =
                window.photosModule && typeof window.photosModule.getPhotoImageUrlForViewer === 'function'
                    ? window.photosModule.getPhotoImageUrlForViewer(photo)
                    : typeof getPhotoImageUrlWithToken === 'function'
                      ? getPhotoImageUrlWithToken(photo)
                      : Promise.resolve(photo.imageUrl || null);
            Promise.resolve(resolveViewerUrl)
                .then((url) => applyUrl(url, name))
                .catch(() => applyUrl('', name));
        } else {
            applyUrl(photo.imageUrl || '', name);
        }
    } else {
        modal.dataset.currentPhotoId = '';
        photoViewerCurrentPhoto = null;
        clearPhotoViewerMicromap();
        syncPhotoViewerMatchShotButton(null);
        syncPhotoViewerCompareButton(null);
        applyUrl(imageUrlOrPhoto, fileName);
    }
    updatePhotoViewerNavControls();
}

// Close photo viewer
function closePhotoViewer() {
    clearPhotoViewerTagsBar();
    clearPhotoViewerStampOverlay();
    clearPhotoViewerMicromap();
    photoViewerCurrentPhoto = null;
    exitPhotoViewerCompare();
    clearPhotoViewerGallery();
    syncPhotoViewerMatchShotButton(null);
    syncPhotoViewerCompareButton(null);
    const modal = document.getElementById('photoViewerModal');
    const image = document.getElementById('photoViewerImage');
    if (image) {
        image.classList.add('server-photo-image-hidden');
        image.removeAttribute('src');
    }
    if (modal) {
        modal.dataset.currentPhotoId = '';
        modal.classList.remove('show');
        document.body.style.overflow = '';
        
        // Reopen only if the hub was open when the viewer opened but something closed it
        // while the viewer was up (e.g. mobile map zoom). If it is still open, skip
        // openDataWindow — that path always triggers a full server refresh.
        const wasOpen = modal.dataset.dataWindowWasOpen === 'true';
        const viewToRestore = modal.dataset.dataWindowView || 'photos';
        const dataWindow = document.getElementById('dataWindow');
        const hubStillOpen = dataWindow && dataWindow.classList.contains('show');
        if (wasOpen && !hubStillOpen && window.openDataWindow) {
            setTimeout(() => {
                window.openDataWindow(viewToRestore);
            }, 100);
        }
        delete modal.dataset.dataWindowWasOpen;
        delete modal.dataset.dataWindowView;
    }
}

// Zoom photo
function zoomPhoto(direction) {
    if (photoViewerCompareActive) return;
    const step = 0.25;
    
    if (direction === 'in') {
        photoViewerZoom = Math.min(photoViewerZoom + step, 5); // Max 5x zoom
    } else if (direction === 'out') {
        photoViewerZoom = Math.max(photoViewerZoom - step, 0.5); // Min 0.5x zoom
    } else if (direction === 'reset') {
        photoViewerZoom = 1;
        photoViewerPanX = 0;
        photoViewerPanY = 0;
    }
    
    updatePhotoViewerTransform();
}

// Update photo viewer transform
function updatePhotoViewerTransform() {
    const image = document.getElementById('photoViewerImage');
    if (image) {
        image.style.transform = `scale(${photoViewerZoom}) translate(${photoViewerPanX}px, ${photoViewerPanY}px)`;
    }
    updatePhotoViewerCursor();
}

// Update cursor based on zoom level
function updatePhotoViewerCursor() {
    const container = document.getElementById('photoViewerImageContainer');
    if (container) {
        container.style.cursor = photoViewerZoom > 1 ? 'grab' : 'default';
    }
}

// Initialize photo viewer drag functionality
function initPhotoViewerDrag() {
    const container = document.getElementById('photoViewerImageContainer');
    if (!container) return;
    
    // Mouse events
    container.addEventListener('mousedown', function(e) {
        if (photoViewerZoom > 1) {
            photoViewerIsDragging = true;
            photoViewerDragStart.x = e.clientX - photoViewerPanX;
            photoViewerDragStart.y = e.clientY - photoViewerPanY;
            container.style.cursor = 'grabbing';
        }
    });
    
    document.addEventListener('mousemove', function(e) {
        if (photoViewerIsDragging && photoViewerZoom > 1) {
            photoViewerPanX = e.clientX - photoViewerDragStart.x;
            photoViewerPanY = e.clientY - photoViewerDragStart.y;
            updatePhotoViewerTransform();
        }
    });
    
    document.addEventListener('mouseup', function() {
        photoViewerIsDragging = false;
        if (container) {
            container.style.cursor = photoViewerZoom > 1 ? 'grab' : 'default';
        }
    });
    
    // Touch events for mobile
    container.addEventListener('touchstart', function(e) {
        if (photoViewerZoom > 1 && e.touches.length === 1) {
            photoViewerIsDragging = true;
            photoViewerDragStart.x = e.touches[0].clientX - photoViewerPanX;
            photoViewerDragStart.y = e.touches[0].clientY - photoViewerPanY;
        }
    });
    
    container.addEventListener('touchmove', function(e) {
        if (photoViewerIsDragging && photoViewerZoom > 1 && e.touches.length === 1) {
            e.preventDefault();
            photoViewerPanX = e.touches[0].clientX - photoViewerDragStart.x;
            photoViewerPanY = e.touches[0].clientY - photoViewerDragStart.y;
            updatePhotoViewerTransform();
        }
    });
    
    container.addEventListener('touchend', function() {
        photoViewerIsDragging = false;
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', function(e) {
        const modal = document.getElementById('photoViewerModal');
        if (!modal || !modal.classList.contains('show')) return;
        // Edit note & tags modal opens above the viewer; don't zoom/close while typing there
        const editModal = document.getElementById('photoDetailsEditModal');
        if (editModal && editModal.classList.contains('show')) return;
        
        if (e.key === 'Escape') {
            closePhotoViewer();
        } else if (
            photoViewerGallery &&
            photoViewerGallery.items.length >= 2 &&
            (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
        ) {
            e.preventDefault();
            stepPhotoViewerGallery(e.key === 'ArrowLeft' ? -1 : 1);
        } else if (e.key === '+' || e.key === '=') {
            zoomPhoto('in');
        } else if (e.key === '-') {
            zoomPhoto('out');
        } else if (e.key === '0') {
            zoomPhoto('reset');
        }
    });
}

function registerMapUploadPickerExports() {
    if (typeof window === 'undefined') return;
    window.openUnifiedMapFilePicker = openUnifiedMapFilePicker;
    window.importPhotosFromInPageCamera = importPhotosFromInPageCamera;
    window.routeSelectedMapFiles = routeSelectedMapFiles;
}

ensurePhotoGalleryFileInputBound();
registerMapUploadPickerExports();
