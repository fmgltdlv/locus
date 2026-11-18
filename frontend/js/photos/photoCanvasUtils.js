// Shared canvas helpers for photo upload resize and export stamping.
(function () {
const PHOTO_STAMP_POSITIONS = ['top', 'bottom', 'bottom_left', 'bottom_right', 'bottom_outside'];
const PHOTO_STAMP_POSITION_STORAGE_KEY = 'photoStampPosition';
const MAP_THUMB_MAX_EDGE = 400;

function normalizePhotoStampPosition(value) {
    const v = String(value || '').trim();
    return PHOTO_STAMP_POSITIONS.includes(v) ? v : 'bottom';
}

function getSavedPhotoStampPosition() {
    try {
        return normalizePhotoStampPosition(localStorage.getItem(PHOTO_STAMP_POSITION_STORAGE_KEY));
    } catch (_) {
        return 'bottom';
    }
}

function savePhotoStampPosition(position) {
    try {
        localStorage.setItem(PHOTO_STAMP_POSITION_STORAGE_KEY, normalizePhotoStampPosition(position));
    } catch (_) {
        /* ignore */
    }
}

function computeStampLayout(lines, imageWidth, imageHeight, position) {
    const pos = normalizePhotoStampPosition(position);
    const fontSize = Math.max(14, Math.round(imageWidth / 40));
    const lineHeight = Math.round(fontSize * 1.35);
    const padX = Math.round(fontSize * 0.6);
    const padY = Math.round(fontSize * 0.45);
    const textBlockHeight = padY * 2 + lineHeight * lines.length;
    return { pos, fontSize, lineHeight, padX, padY, textBlockHeight };
}

function measureStampTextWidth(ctx, lines) {
    let maxW = 0;
    for (const line of lines) {
        maxW = Math.max(maxW, ctx.measureText(line).width);
    }
    return maxW;
}

function drawStampOverlay(ctx, canvasWidth, canvasHeight, imageHeight, lines, position) {
    if (!lines.length) return;

    const layout = computeStampLayout(lines, canvasWidth, imageHeight, position);
    const { pos, fontSize, lineHeight, padX, padY, textBlockHeight } = layout;

    ctx.font = `600 ${fontSize}px sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';

    const maxTextW = measureStampTextWidth(ctx, lines);

    if (pos === 'bottom_outside') {
        const barTop = imageHeight;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.fillRect(0, barTop, canvasWidth, textBlockHeight);
        ctx.fillStyle = '#ffffff';
        lines.forEach(function (line, index) {
            ctx.fillText(line, padX, barTop + padY + index * lineHeight);
        });
        return;
    }

    let boxX = padX;
    let boxY = 0;
    let boxW = canvasWidth;
    let boxH = textBlockHeight;

    if (pos === 'top') {
        boxX = 0;
        boxY = 0;
        boxW = canvasWidth;
    } else if (pos === 'bottom') {
        boxX = 0;
        boxY = imageHeight - textBlockHeight;
        boxW = canvasWidth;
    } else if (pos === 'bottom_left') {
        boxW = maxTextW + padX * 2;
        boxH = textBlockHeight;
        boxX = padX;
        boxY = imageHeight - boxH - padY;
    } else if (pos === 'bottom_right') {
        boxW = maxTextW + padX * 2;
        boxH = textBlockHeight;
        boxX = canvasWidth - boxW - padX;
        boxY = imageHeight - boxH - padY;
    }

    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.fillStyle = '#ffffff';

    lines.forEach(function (line, index) {
        let textX = boxX + padX;
        if (pos === 'bottom_right') {
            textX = boxX + boxW - padX - ctx.measureText(line).width;
        }
        const textY = boxY + padY + index * lineHeight;
        ctx.fillText(line, textX, textY);
    });
}

function canvasToJpegBlob(canvas, quality) {
    return new Promise(function (resolve) {
        if (!canvas || !canvas.toBlob) {
            resolve(null);
            return;
        }
        canvas.toBlob(function (blob) {
            resolve(blob || null);
        }, 'image/jpeg', quality);
    });
}

const OFFLINE_THUMB_MAX_EDGE = 256;

/**
 * Resize a photo file to a JPEG thumbnail blob for offline previews.
 * @param {Blob|File} file
 * @param {number} [maxEdge]
 * @returns {Promise<Blob|null>}
 */
async function generateJpegThumbnailBlob(file, maxEdge) {
    if (!file) return null;
    const edge = Number.isFinite(maxEdge) && maxEdge > 0 ? maxEdge : OFFLINE_THUMB_MAX_EDGE;
    try {
        const decoded = await decodeImageForCanvas(file);
        const { drawable, isBitmap } = decoded;
        const dim = drawableWidthHeight(drawable, isBitmap);
        if (!dim.w || !dim.h) {
            if (isBitmap && drawable.close) drawable.close();
            return null;
        }
        const scale = Math.min(1, edge / Math.max(dim.w, dim.h));
        const tw = Math.max(1, Math.round(dim.w * scale));
        const th = Math.max(1, Math.round(dim.h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = tw;
        canvas.height = th;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            if (isBitmap && drawable.close) drawable.close();
            return null;
        }
        ctx.drawImage(drawable, 0, 0, tw, th);
        if (isBitmap && drawable.close) drawable.close();
        return await canvasToJpegBlob(canvas, 0.82);
    } catch (_) {
        return null;
    }
}

function loadImageFromFileViaImageElement(file) {
    return new Promise(function (resolve, reject) {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = function () {
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = function () {
            URL.revokeObjectURL(url);
            reject(new Error('decode'));
        };
        img.src = url;
    });
}

/**
 * Decode image for canvas; prefers createImageBitmap (EXIF orientation) when available.
 * @returns {Promise<{ drawable: ImageBitmap|HTMLImageElement, isBitmap: boolean }>}
 */
async function decodeImageForCanvas(file) {
    const input = file instanceof Blob && !(file instanceof File)
        ? new File([file], 'photo.jpg', { type: file.type || 'image/jpeg' })
        : file;
    if (typeof createImageBitmap === 'function') {
        try {
            const b = await createImageBitmap(input, { imageOrientation: 'from-image' });
            return { drawable: b, isBitmap: true };
        } catch (_) {
            try {
                const b2 = await createImageBitmap(input);
                return { drawable: b2, isBitmap: true };
            } catch (_) {
                /* fall through */
            }
        }
    }
    const img = await loadImageFromFileViaImageElement(input);
    return { drawable: img, isBitmap: false };
}

function drawableWidthHeight(drawable, isBitmap) {
    if (isBitmap) {
        return { w: drawable.width, h: drawable.height };
    }
    return { w: drawable.naturalWidth, h: drawable.naturalHeight };
}

function formatPhotoStampDateTime(isoOrExif) {
    if (isoOrExif != null && String(isoOrExif).trim() !== '') {
        const raw = String(isoOrExif).trim();
        const exifMatch = raw.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}:\d{2}:\d{2})/);
        if (exifMatch && typeof window.formatRecordedExifWallClock === 'function') {
            const hm = exifMatch[4].split(':');
            return window.formatRecordedExifWallClock(exifMatch[1], exifMatch[2], exifMatch[3], hm[0], hm[1]);
        }
        if (typeof window.formatRecordedDateTime === 'function') {
            const formatted = window.formatRecordedDateTime(raw, '', '');
            if (formatted) return formatted;
        }
        return raw;
    }
    if (typeof window.formatRecordedDateTime === 'function') {
        return window.formatRecordedDateTime(new Date());
    }
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function getPhotoExportDateTime(photo) {
    const exifDt = photo?.exifData?.dateTime;
    if (exifDt != null && String(exifDt).trim() !== '') {
        return formatPhotoStampDateTime(exifDt);
    }
    if (photo?.createdAt) {
        return formatPhotoStampDateTime(photo.createdAt);
    }
    return formatPhotoStampDateTime(null);
}

function buildPhotoStampContextFromUpload(latlng, exifData) {
    const exif = exifData && typeof exifData === 'object' ? { ...exifData } : {};
    if (!exif.dateTime) {
        exif.dateTime = formatPhotoStampDateTime(null);
    }
    return {
        latlng: latlng && latlng.lat != null && latlng.lng != null
            ? { lat: Number(latlng.lat), lng: Number(latlng.lng) }
            : null,
        exifData: exif,
        createdAt: new Date().toISOString()
    };
}

/**
 * Burn GPS/date onto a File (export / optional paths only — uploads stay unstamped).
 * Returns original file if stamping fails.
 * @returns {Promise<File>}
 */
async function stampPhotoFileForUpload(file, latlng, exifData) {
    if (!file) {
        return file;
    }
    try {
        const context = buildPhotoStampContextFromUpload(latlng, exifData);
        const stamped = await stampPhotoWithGpsAndDate(file, context, {
            position: getSavedPhotoStampPosition()
        });
        const baseName = (file.name && file.name.replace(/\.[^.]+$/, '')) || 'photo';
        return new File([stamped], baseName + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
    } catch (error) {
        console.warn('Photo timestamp stamp failed, using original:', error);
        return file;
    }
}

function formatPhotoExportCoordinates(photo) {
    if (!photo || typeof photo !== 'object') return '';
    let lat = Number(photo.latlng && photo.latlng.lat);
    let lng = Number(photo.latlng && photo.latlng.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        const ex = photo.exifData;
        if (ex && ex.gpsLat != null && ex.gpsLng != null) {
            lat = Number(ex.gpsLat);
            lng = Number(ex.gpsLng);
        }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
    return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

/**
 * Convert compass degrees (0–360, clockwise from north) to quadrant azimuth text.
 * @param {number} degrees
 * @returns {string}
 */
function formatPhotoHeadingAzimuth(degrees) {
    if (!Number.isFinite(degrees)) return '';
    let deg = Math.round(((Number(degrees) % 360) + 360) % 360);
    if (deg === 360) deg = 0;
    if (deg === 0) return 'N';
    if (deg === 90) return 'E';
    if (deg === 180) return 'S';
    if (deg === 270) return 'W';
    if (deg > 0 && deg < 90) return `N ${deg}\u00B0 E`;
    if (deg > 90 && deg < 180) return `S ${180 - deg}\u00B0 E`;
    if (deg > 180 && deg < 270) return `S ${deg - 180}\u00B0 W`;
    return `N ${360 - deg}\u00B0 W`;
}

/**
 * @param {object} photo
 * @returns {number|null}
 */
function getPhotoHeadingDegrees(photo) {
    if (!photo || typeof photo !== 'object') return null;
    const raw =
        photo.exifData && photo.exifData.gpsHeadingDegrees != null
            ? photo.exifData.gpsHeadingDegrees
            : photo.metadata && photo.metadata.gpsHeadingDegrees != null
              ? photo.metadata.gpsHeadingDegrees
              : null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 360) return null;
    return n;
}

/**
 * Lenient: valid finite degrees 0–360 (gpsHeadingSource optional).
 * @param {object} photo
 * @returns {boolean}
 */
function photoHasHeading(photo) {
    return getPhotoHeadingDegrees(photo) != null;
}

/**
 * @param {object} photo
 * @returns {number|null}
 */
function getPhotoGpsAccuracyMeters(photo) {
    if (!photo || typeof photo !== 'object') return null;
    const raw =
        photo.exifData && photo.exifData.gpsAccuracyMeters != null
            ? photo.exifData.gpsAccuracyMeters
            : photo.metadata && photo.metadata.gpsAccuracyMeters != null
              ? photo.metadata.gpsAccuracyMeters
              : null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

/**
 * @param {object} photo
 * @returns {string}
 */
function getPhotoGpsAccuracyStampLine(photo) {
    const meters = getPhotoGpsAccuracyMeters(photo);
    if (meters == null) return '';
    return `\u00B1${Math.round(meters)} m`;
}

/**
 * @param {object} photo
 * @returns {string}
 */
function getPhotoHeadingStampLine(photo) {
    if (!photoHasHeading(photo)) return '';
    const deg = getPhotoHeadingDegrees(photo);
    if (deg == null) return '';
    return formatPhotoHeadingAzimuth(deg);
}

/**
 * Date, GPS, and optional heading lines for overlay / export stamp.
 * @param {object} photo
 * @param {{ exportMode?: boolean }} [options] exportMode adds date "now" fallback (burn-in export only)
 * @returns {string[]}
 */
function buildPhotoStampLines(photo, options) {
    if (!photo || typeof photo !== 'object') return [];
    const exportMode = !!(options && options.exportMode);
    const lines = [];
    const exifDt = photo.exifData && photo.exifData.dateTime;
    if (exifDt != null && String(exifDt).trim() !== '') {
        lines.push(formatPhotoStampDateTime(exifDt));
    } else if (photo.createdAt) {
        lines.push(formatPhotoStampDateTime(photo.createdAt));
    } else if (exportMode) {
        const dateLine = getPhotoExportDateTime(photo);
        if (dateLine) lines.push(dateLine);
    }
    const coordLine = formatPhotoExportCoordinates(photo);
    if (coordLine) lines.push(coordLine);
    const accuracyLine = getPhotoGpsAccuracyStampLine(photo);
    if (accuracyLine) lines.push(accuracyLine);
    const headingLine = getPhotoHeadingStampLine(photo);
    if (headingLine) lines.push(headingLine);
    return lines;
}

/**
 * Date/GPS lines for a non-destructive viewer overlay (no "now" fallback).
 * @param {object} photo
 * @returns {string[]}
 */
function getPhotoStampOverlayLines(photo) {
    return buildPhotoStampLines(photo);
}

/**
 * Burn datetime and optional GPS coordinates onto a photo blob.
 * @param {Blob|File} blob
 * @param {object} photo
 * @param {{ position?: string }} [stampOptions]
 * @returns {Promise<Blob>}
 */
async function stampPhotoWithGpsAndDate(blob, photo, stampOptions) {
    const position = normalizePhotoStampPosition(stampOptions?.position || getSavedPhotoStampPosition());
    const decoded = await decodeImageForCanvas(blob);
    const drawable = decoded.drawable;
    const isBitmap = decoded.isBitmap;
    const dim = drawableWidthHeight(drawable, isBitmap);
    const w = dim.w;
    const h = dim.h;
    if (!w || !h) {
        if (isBitmap && drawable.close) drawable.close();
        throw new Error('Invalid image dimensions');
    }

    const lines = buildPhotoStampLines(photo, { exportMode: true });

    const layout = computeStampLayout(lines, w, h, position);
    const extraHeight = position === 'bottom_outside' && lines.length > 0 ? layout.textBlockHeight : 0;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        if (isBitmap && drawable.close) drawable.close();
        throw new Error('Canvas not supported');
    }

    canvas.width = w;
    canvas.height = h + extraHeight;
    ctx.drawImage(drawable, 0, 0, w, h);
    if (isBitmap && drawable.close) drawable.close();

    if (lines.length > 0) {
        drawStampOverlay(ctx, w, h + extraHeight, h, lines, position);
    }

    const out = await canvasToJpegBlob(canvas, 0.92);
    if (!out) throw new Error('Failed to encode stamped photo');
    return out;
}

window.photoCanvasUtils = {
    MAP_THUMB_MAX_EDGE,
    canvasToJpegBlob,
    generateJpegThumbnailBlob,
    decodeImageForCanvas,
    drawableWidthHeight,
    formatPhotoStampDateTime,
    getPhotoExportDateTime,
    getPhotoStampOverlayLines,
    buildPhotoStampLines,
    formatPhotoHeadingAzimuth,
    getPhotoHeadingDegrees,
    photoHasHeading,
    getPhotoGpsAccuracyMeters,
    getPhotoGpsAccuracyStampLine,
    getPhotoHeadingStampLine,
    formatPhotoExportCoordinates,
    buildPhotoStampContextFromUpload,
    normalizePhotoStampPosition,
    getSavedPhotoStampPosition,
    savePhotoStampPosition,
    stampPhotoFileForUpload,
    stampPhotoWithGpsAndDate
};
})();
