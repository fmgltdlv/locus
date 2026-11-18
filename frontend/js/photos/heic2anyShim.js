// CSP-safe HEIC decode (heic-to/csp uses libheif compiled without unsafe-eval).
// heic2any fails under production CSP because its worker calls new Function().
import { heicTo } from 'heic-to/csp';

if (typeof window !== 'undefined') {
    /**
     * Convert an HEIC/HEIF blob to a JPEG Blob in the browser.
     * @param {Blob} blob
     * @returns {Promise<Blob>}
     */
    window.__convertHeicToJpeg = async function (blob) {
        return heicTo({ blob: blob, type: 'image/jpeg', quality: 0.9 });
    };
}
