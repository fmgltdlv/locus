// Client-side downsample for organization menu icons (radial wheel thumbnails).
(function () {
    'use strict';

    function loadImageFromFile(file) {
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

    async function decodeOrgIconFile(file) {
        if (typeof createImageBitmap === 'function') {
            try {
                const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
                return { drawable: bitmap, isBitmap: true };
            } catch (_) {
                try {
                    const bitmap = await createImageBitmap(file);
                    return { drawable: bitmap, isBitmap: true };
                } catch (_) {
                    /* fall through */
                }
            }
        }
        const img = await loadImageFromFile(file);
        return { drawable: img, isBitmap: false };
    }

    function drawableSize(drawable, isBitmap) {
        if (isBitmap) {
            return { w: drawable.width, h: drawable.height };
        }
        return { w: drawable.naturalWidth, h: drawable.naturalHeight };
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

    /**
     * Resize/crop image to a square JPEG suitable for org menu icon upload.
     * @param {File|Blob} file
     * @param {number} [maxPx=128]
     * @returns {Promise<File|null>}
     */
    async function resizeOrgIconFile(file, maxPx) {
        const edge = Number(maxPx) > 0 ? Number(maxPx) : 128;
        if (!file) return null;

        let decoded = null;
        try {
            decoded = await decodeOrgIconFile(file);
        } catch (_) {
            return null;
        }

        const drawable = decoded.drawable;
        const isBitmap = decoded.isBitmap;
        const dim = drawableSize(drawable, isBitmap);
        const w = dim.w;
        const h = dim.h;
        if (!w || !h) {
            if (isBitmap && drawable.close) drawable.close();
            return null;
        }

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            if (isBitmap && drawable.close) drawable.close();
            return null;
        }

        const side = Math.min(w, h);
        const sx = Math.max(0, Math.floor((w - side) / 2));
        const sy = Math.max(0, Math.floor((h - side) / 2));
        canvas.width = edge;
        canvas.height = edge;
        ctx.drawImage(drawable, sx, sy, side, side, 0, 0, edge, edge);
        if (isBitmap && drawable.close) drawable.close();

        const blob = await canvasToJpegBlob(canvas, 0.85);
        if (!blob) return null;
        const baseName = file instanceof File && file.name ? file.name.replace(/\.[^.]+$/, '') : 'org-icon';
        return new File([blob], baseName + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
    }

    window.orgIconUtils = {
        resizeOrgIconFile: resizeOrgIconFile,
    };
})();
