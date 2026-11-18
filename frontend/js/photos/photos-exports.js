
// Make functions globally available
window.initPhotoUpload = initPhotoUpload;
window.initPhotoUploadFromCamera = initPhotoUploadFromCamera;
window.initPhotoUploadFromGallery = initPhotoUploadFromGallery;
window.initPhotoUploadFromInPageCamera = initPhotoUploadFromInPageCamera;
window.openUnifiedMapFilePicker = openUnifiedMapFilePicker;
window.importPhotosFromInPageCamera = importPhotosFromInPageCamera;
window.closeMobilePhotoSourceMenu = closeMobilePhotoSourceMenu;
window.openPhotoViewer = openPhotoViewer;
window.openPhotoStakeCamera = openPhotoStakeCamera;
window.closePhotoViewer = closePhotoViewer;
window.stepPhotoViewerGallery = stepPhotoViewerGallery;
window.closePhotoMapInfoModal = closePhotoMapInfoModal;
window.openPhotoMapInfoModal = openPhotoMapInfoModal;
window.zoomPhoto = zoomPhoto;
window.renamePhotoBatch = renamePhotoBatch;

// Expose photoUploadMode for annotations module
Object.defineProperty(window, 'photoUploadMode', {
    get: function() { return photoUploadMode; },
    configurable: true
});

Object.defineProperty(window, 'photoLocationTagMode', {
    get: function () { return photoLocationTagMode; },
    configurable: true
});

// Export for use in other modules
window.photosModule = {
    passesTimeWarpFilter: (photo) => photoPassesTimeWarp(photo),
    get photoUploadMode() { return photoUploadMode; },
    get photoLocationTagMode() { return photoLocationTagMode; },
    setPhotoLocationTagMode,
    startPhotoLocationTagClick,
    finishPhotoLocationTagClick,
    cancelPhotoLocationTag,
    get savedPhotos() { return savedPhotos; },
    get photoBatches() { return photoBatches; },
    get photosLayerGroup() { return photosLayerGroup; },
    cancelPhotoUpload,
    initPhotoViewerDrag,
    loadSavedPhotos,
    loadPhotosFromServer,
    invalidateManageDataPhotosSync,
    ensureManageDataPhotosLoaded,
    savePhotos,
    clearPhotosFromMap,
    reloadPhotosOnMap,
    initPhotosLayer,
    isPhotosLayerUserEnabled,
    updatePhotosLayerControl,
    syncPhotosLayerForZoom,
    setPhotosHiddenForTicketDraw,
    forEachTicketDrawPhotoLayer,
    loadPhotoBatches,
    savePhotoBatches,
    getPhotoImageUrl,
    getPhotoThumbnailDisplayUrl,
    getPhotoImageUrlWithToken,
    getPhotoImageUrlForViewer,
    setServerPhotoImageSources,
    fetchMediaAccessToken,
    fetchPhotoFileBlob,
    blobFromPhotoForExport,
    promptEditPhotoNote,
    promptEditPhotoDetails,
    findPhotoForUi,
    syncPhotoDetailsAcrossLocalCopies,
    enrichPhotoDetailsFromLocalCopies,
    openPhotoMapInfoModal,
    patchPhotoDetailsOnServer,
    isPhotoManualGps,
    formatPhotoGpsLastEditedLine,
    patchPhotoGpsOnServer,
    clearPhotoGpsOnServer,
    deleteMediaFileOnServer,
    enqueuePendingMediaDelete,
    flushPendingMediaDeletes,
    setPhotoGpsLocally,
    clearPhotoGpsLocally,
    removePhotoMarker,
    getPhotoMapMarkerIconHtml,
    getPhotoMapMarkerClassName,
    applyPhotoGpsMetadataFromResponse,
    placeOrMovePhotoMarker,
    syncPhotoMapAfterGpsChange,
    refreshPhotoMarkerPopup,
    renamePhotoBatch,
    getPhotoBatchDisplayPrimaryLabel,
    getPhotoBatchNameSortKey,
    patchPhotoBatchNameOnServer,
    buildPhotoMapPopupHtml,
    wirePhotoMapMarkerPopup,
    createPhotoMarkerWithPopup,
    createNoGpsTicketClusterMarker,
    bindPhotoPopupNoteButton,
    centerMapOnPhotoPopup,
    wirePhotoMapMarkerLeafletMobile,
    getPhotoThumbnailObjectUrlCached,
    getPhotoFullObjectUrlCached,
    getPhotoThumbnailBlobCached,
    getPhotoFullBlobCached,
    clearPhotoThumbnailObjectUrlCache,
    evictPhotoBlobCachesForFile,
    hydrateTicketPopupThumbnailElement,
    isInPageCameraOverlayOpen,
    hasActivePhotoUploadWork,
    closeInPageCameraOnAppHidden: ipcCloseInPageCameraOnAppHidden,
    setPhotoPublicFlag,
    canAdminPhotoPublicFlag,
    clearPublicSearchPhotosFromMap,
    renderPublicSearchPhotosOnMap,
    clearServerPhotoClusters,
    clearNoGpsTicketClusters,
    clearPhotoMapClusterHighlight,
    resetPhotoMapClusterHighlight,
    renderServerPhotoClustersOnMap,
    renderNoGpsTicketClustersOnMap,
    setMapNoGpsClustersFromPayload,
    openPhotoFromMapItem,
    getPhotosForMapRender,
    replaceOrgPhotosFromOfflineCache,
    fetchThumbnailBlobForOffline,
    reconcileOfflineUploadSuccess,
    getPhotoStakeOfPhotoId:
        window.photoStakeUtils && typeof window.photoStakeUtils.getPhotoStakeOfPhotoId === 'function'
            ? window.photoStakeUtils.getPhotoStakeOfPhotoId
            : undefined,
    isRestakedPhoto:
        window.photoStakeUtils && typeof window.photoStakeUtils.isRestakedPhoto === 'function'
            ? window.photoStakeUtils.isRestakedPhoto
            : undefined,
    resolveStakeReferencePhoto:
        window.photoStakeUtils && typeof window.photoStakeUtils.resolveStakeReferencePhoto === 'function'
            ? window.photoStakeUtils.resolveStakeReferencePhoto
            : undefined,
};
window.photosModule.getGpsFromImageFile = getGpsFromImageFile;

