import piexif from 'piexifjs';

function arrayBufferToBinaryString(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return binary;
}

function binaryStringToJpegBlob(binary) {
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i) & 0xff;
    }
    return new Blob([bytes], { type: 'image/jpeg' });
}

function isJpegMime(blob) {
    if (!blob) return false;
    const type = String(blob.type || '').toLowerCase();
    return type === 'image/jpeg' || type === 'image/jpg';
}

async function blobLooksLikeJpeg(blob) {
    if (isJpegMime(blob)) return true;
    if (!blob || typeof blob.slice !== 'function') return false;
    try {
        const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
        return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    } catch (_) {
        return false;
    }
}

/**
 * Re-encode any image blob as JPEG via canvas (strips existing EXIF).
 * @param {Blob} blob
 * @returns {Promise<Blob>}
 */
async function ensureJpegBlob(blob) {
    if (await blobLooksLikeJpeg(blob)) {
        if (!isJpegMime(blob)) {
            return new Blob([blob], { type: 'image/jpeg' });
        }
        return blob;
    }
    const utils = typeof window !== 'undefined' ? window.photoCanvasUtils : null;
    if (!utils?.decodeImageForCanvas || !utils?.canvasToJpegBlob) {
        throw new Error('Photo canvas helpers not loaded');
    }
    const decoded = await utils.decodeImageForCanvas(blob);
    const drawable = decoded.drawable;
    const isBitmap = decoded.isBitmap;
    const dim = utils.drawableWidthHeight(drawable, isBitmap);
    if (!dim.w || !dim.h) {
        if (isBitmap && drawable.close) drawable.close();
        throw new Error('Invalid image dimensions');
    }
    const canvas = document.createElement('canvas');
    canvas.width = dim.w;
    canvas.height = dim.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        if (isBitmap && drawable.close) drawable.close();
        throw new Error('Canvas not supported');
    }
    ctx.drawImage(drawable, 0, 0, dim.w, dim.h);
    if (isBitmap && drawable.close) drawable.close();
    const out = await utils.canvasToJpegBlob(canvas, 0.92);
    if (!out) throw new Error('Failed to encode JPEG');
    return out;
}

function rationalDegrees(deg) {
    const rounded = Math.round(Number(deg));
    return [[rounded, 1]];
}

function rationalMeters(meters) {
    const rounded = Math.round(Number(meters) * 100);
    return [[rounded, 100]];
}

/**
 * Write GPS coordinates (and optional heading / accuracy) into JPEG EXIF.
 * @param {Blob} blob
 * @param {number} lat
 * @param {number} lng
 * @param {{ headingDegrees?: number|null, accuracyMeters?: number|null }} [options]
 * @returns {Promise<Blob>}
 */
async function embedGpsInJpegBlob(blob, lat, lng, options) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new Error('Invalid GPS coordinates');
    }
    const headingDegrees = options && options.headingDegrees != null ? Number(options.headingDegrees) : null;
    const accuracyMeters = options && options.accuracyMeters != null ? Number(options.accuracyMeters) : null;

    const jpegBlob = await ensureJpegBlob(blob);
    const binary = arrayBufferToBinaryString(await jpegBlob.arrayBuffer());

    let zeroth = {};
    let exif = {};
    let gps = {};
    try {
        const loaded = piexif.load(binary);
        zeroth = loaded['0th'] || {};
        exif = loaded.Exif || {};
        gps = loaded.GPS || {};
    } catch (_) {
        /* no existing EXIF */
    }

    gps[piexif.GPSIFD.GPSVersionID] = [2, 0, 0, 0];
    gps[piexif.GPSIFD.GPSLatitudeRef] = lat >= 0 ? 'N' : 'S';
    gps[piexif.GPSIFD.GPSLatitude] = piexif.GPSHelper.degToDmsRational(Math.abs(lat));
    gps[piexif.GPSIFD.GPSLongitudeRef] = lng >= 0 ? 'E' : 'W';
    gps[piexif.GPSIFD.GPSLongitude] = piexif.GPSHelper.degToDmsRational(Math.abs(lng));

    delete gps[piexif.GPSIFD.GPSImgDirection];
    delete gps[piexif.GPSIFD.GPSImgDirectionRef];
    if (headingDegrees != null && Number.isFinite(headingDegrees)) {
        let h = Math.round(((headingDegrees % 360) + 360) % 360);
        if (h === 360) h = 0;
        gps[piexif.GPSIFD.GPSImgDirectionRef] = 'T';
        gps[piexif.GPSIFD.GPSImgDirection] = rationalDegrees(h);
    }

    delete gps[piexif.GPSIFD.GPSHPositioningError];
    if (accuracyMeters != null && Number.isFinite(accuracyMeters) && accuracyMeters > 0) {
        gps[piexif.GPSIFD.GPSHPositioningError] = rationalMeters(accuracyMeters);
    }

    const exifBytes = piexif.dump({
        '0th': zeroth,
        Exif: exif,
        GPS: gps,
    });
    const newBinary = piexif.insert(exifBytes, binary);
    return binaryStringToJpegBlob(newBinary);
}

if (typeof window !== 'undefined') {
    window.__embedGpsInJpegBlob = embedGpsInJpegBlob;
    window.photoExifWrite = {
        embedGpsInJpegBlob,
        ensureJpegBlob,
    };
}
