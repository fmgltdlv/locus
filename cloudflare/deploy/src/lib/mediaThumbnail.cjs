/**
 * Workers bundle: sharp is unavailable. Thumbnails are skipped; callers store null thumbnail_path.
 * (Optional: Cloudflare Images / WASM photon / client-side thumbs.)
 */
const THUMB_MAX_PX = 400;

/**
 * @param {string} fileType
 * @param {string} [mime]
 * @returns {boolean}
 */
function shouldGenerateThumbnail(fileType, mime) {
    void THUMB_MAX_PX;
    return false;
}

/**
 * @param {string} sourceAbsolutePath
 * @param {string} destAbsolutePath
 * @returns {Promise<boolean>}
 */
async function generatePhotoThumbnail(sourceAbsolutePath, destAbsolutePath) {
    void sourceAbsolutePath;
    void destAbsolutePath;
    return false;
}

/**
 * @param {Buffer} inputBuffer
 * @returns {Promise<Buffer | null>}
 */
async function generatePhotoThumbnailFromBuffer(inputBuffer) {
    void inputBuffer;
    return null;
}

module.exports = {
    shouldGenerateThumbnail,
    generatePhotoThumbnail,
    generatePhotoThumbnailFromBuffer,
};
