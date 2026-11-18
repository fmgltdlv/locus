/**
 * Photo stake (match/restake) lineage helpers.
 */
(function () {
    function normalizeStakePhotoId(value) {
        if (value == null || value === '') return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    function getPhotoStakeOfPhotoId(photo) {
        if (!photo) return null;
        if (photo.stakeOfPhotoId != null) {
            const fromPhoto = normalizeStakePhotoId(photo.stakeOfPhotoId);
            if (fromPhoto != null) return fromPhoto;
        }
        const exif = photo.exifData;
        if (exif && exif.stakeOfPhotoId != null) {
            return normalizeStakePhotoId(exif.stakeOfPhotoId);
        }
        return null;
    }

    function isRestakedPhoto(photo) {
        return getPhotoStakeOfPhotoId(photo) != null;
    }

    function resolveStakeReferencePhoto(photo) {
        const refId = getPhotoStakeOfPhotoId(photo);
        if (refId == null) return null;
        if (typeof findPhotoForUi === 'function') {
            return findPhotoForUi(refId);
        }
        const list = window.photosModule && window.photosModule.savedPhotos;
        if (!Array.isArray(list)) return null;
        return list.find(function (p) {
            return p && Number(p.fileId) === refId;
        }) || null;
    }

    function applyStakeFieldsFromMeta(photo, meta) {
        if (!photo || !meta || typeof meta !== 'object') return photo;
        if (meta.stakeOfPhotoId != null) {
            const id = normalizeStakePhotoId(meta.stakeOfPhotoId);
            if (id != null) photo.stakeOfPhotoId = id;
        }
        if (Number.isFinite(Number(meta.stakeGhostOpacity))) {
            photo.stakeGhostOpacity = Number(meta.stakeGhostOpacity);
        }
        return photo;
    }

    function applyStakeFieldsFromExif(photo, exifData) {
        if (!photo || !exifData || typeof exifData !== 'object') return photo;
        if (exifData.stakeOfPhotoId != null) {
            const id = normalizeStakePhotoId(exifData.stakeOfPhotoId);
            if (id != null) photo.stakeOfPhotoId = id;
        }
        if (Number.isFinite(Number(exifData.stakeGhostOpacity))) {
            photo.stakeGhostOpacity = Number(exifData.stakeGhostOpacity);
        }
        return photo;
    }

    function filterRestakedPhotos(photos) {
        if (!Array.isArray(photos)) return [];
        return photos.filter(function (p) {
            return isRestakedPhoto(p);
        });
    }

    window.photoStakeUtils = {
        normalizeStakePhotoId: normalizeStakePhotoId,
        getPhotoStakeOfPhotoId: getPhotoStakeOfPhotoId,
        isRestakedPhoto: isRestakedPhoto,
        resolveStakeReferencePhoto: resolveStakeReferencePhoto,
        applyStakeFieldsFromMeta: applyStakeFieldsFromMeta,
        applyStakeFieldsFromExif: applyStakeFieldsFromExif,
        filterRestakedPhotos: filterRestakedPhotos,
    };
})();
