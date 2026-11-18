// Export for use in other modules (must be after all functions are defined)
window.ticketsModule = {
    applyTicketStatusFromImporter,
    reapplyTicketStatusesForLoadedCollections,
    syncExpiredLifecycleIntoOrgTickets,
    getTicketWorkflowStatusForMap,
    isInactiveWorkflowStatus,
    getTicketResponseProgress,
    getTicketOrganizationDisplayName,
    getTicketAssignedUsers,
    isTicketVisibleToTechClient,
    refreshTechVisibleTicketNumbers,
    clearTechVisibleTicketNumbersCache,
    isTicketInternalForOrg: ticketIsInternalOrg,
    isTicketExternalForOrg: ticketIsExternalOrg,
    getTicketTimeMs: getTicketTimeWarpMs,
    passesTimeWarpFilter: (ticket) => ticketPassesTimeWarp(ticket),
    normalizeTicketListSort,
    compareTicketsForListSort,
    renderTickets,
    applyTicketMapSelectionUiUpdate,
    refreshTicketMapSelectionVisuals,
    syncTicketMapEntryRefreshLoading,
    renderTicketList,
    loadTicketsForCurrentOrg,
    hydrateHubTicketJobNames,
    loadExpiredTicketsForHub,
    loadActiveTicketsForHub,
    loadCombinedTicketsForHub,
    loadHubTicketSliceForCurrentFilters,
    clearHubExpiredTickets,
    clearHubActiveTickets,
    clearHubCombinedTickets,
    clearHubTicketSlices,
    clearHubRecentlyOpenedTickets,
    resolveTicketForOpen,
    findLiveTicketInLocalCollections,
    invalidateTicketsOrgCache,
    refreshTicketsOrgCacheSnapshot,
    areTicketsFreshForOrg,
    getLastTicketsFullLoadAtForOrg,
    isTicketsLoadInFlightForOrg,
    awaitTicketsLoadForOrg,
    mergeImportedTicketsIntoOrgList,
    runIncrementalUsanListSyncChain,
    runIncrementalPacPollChain: runIncrementalUsanListSyncChain,
    usanPollResultTouchedTickets,
    setTicketListUsanSyncing,
    setTicketListDataUpdating,
    setTicketListProgressiveLoadedCount,
    getTicketListProgressiveLoadedCount,
    isTicketListSummaryLoadBusy,
    isTicketListUsanSyncBusy,
    scheduleAppendTicketsToMap,
    appendTicketsToMap,
    applyTicketPolygonBackfillToMap,
    clearProgressiveTicketListLoadState,
    clearTicketListFrozenDisplayOrder,
    resetTicketListVirtualSliceCache,
    setTicketListPacSyncing: setTicketListUsanSyncing,
    ticketSelectionRefreshLoading,
    setTicketSelectionRefreshLoading: setSelectedTicketRefreshLoading,
    refreshTicketLiteForSelection,
    hydrateTicketFromDbDetail,
    ensureTicketOperatorResponsesLoaded,
    isTicketOperatorResponsesLoadInFlight,
    isTicketOperatorResponsesLoadPending,
    isTicketResponsesLockoutFresh,
    canShowTicketOperatorResponsesNow,
    ticketOperatorResponseRowsForDisplay,
    isNvPublicImportTicketClient,
    shouldDeferPosrOperatorResponsesEmptyState,
    userMayRefreshTicketFrom811,
    ticketNeedsNgenFullDetailRefresh,
    isTicketPopupOpenRefreshCoopLocked,
    isTicketRefreshInFlight,
    resolveLiveTicketForRefresh,
    ticketMayAutoRefreshOnPopupOpen,
    ticketMapPopupMayRefresh811,
    getTicketPerRefreshLockMs,
    selectTicket,
    selectedTicketId: () => selectedTicketId,
    openTicketImporter,
    closeTicketImporter,
    importTickets,
    syncTicketLayerPointerInteraction,
    hasTicketInCurrentMapView,
    getTicketLayers: () => ticketMapEntries.map(e => e.polygon).filter(Boolean),
    getTicketLayerGroup: () => ticketLayerGroup,
    highlightTicketPolygonsForQueryMode,
    highlightComplianceHubProjectMapPickSelection,
    restoreTicketMapPolygonStyles,
    syncTicketMapPolygonFillForZoom,
    scheduleViewportPolygonBackfillForVisibleTickets,
    closeOverlappingTicketPicker,
    isOverlappingTicketPickerOpen,
    loadAerialMapsForTicket,
    initTicketPopupResize,
    loadTicketPopupHeight,
    saveTicketPopupDimensions,
    updateTicketsLayerControl,
    zoomToAllTickets,
    fitMapToTickets,
    checkTicketsAfterPhotoChange, // Export for photo module
    refreshOpenTicketPopupAfterPhotoChange,
    refreshTicketUiAfterPhotoChange,
    invalidateTicketPhotoIntersectionsForPhoto,
    scheduleTicketPhotoIntersectionRefresh,
    getPhotosInTicketPolygon, // Export for getting photos
    resolveTicketLinkedPhotosUnfiltered,
    ensureTicketPhotosFromApi,
    refreshOpenTicketPopupPhotoCounts,
    patchOpenTicketPopupDetail,
    getTicketPhotoWindowDisplayStats,
    getTicketPopupPreviewPhoto,
    ticketHasDisplayablePolygon,
    ticketMapAnchorLatLng,
    ticketIntersectsMapBounds,
    ticketPolygonBackfillLoading,
    ticketPolygonBackfillUnsettled,
    showTicketPhotos, // Export for showing photo viewer
    formatAssigneeCountLabel
};

// Make functions globally available for HTML onclick handlers
// These must be exported AFTER the functions are defined
// Note: toggleTicketList is exported immediately after its definition above
window.selectTicket = selectTicket;
window.closeTicketPopup = closeTicketPopup;
window.hideTicketPopupKeepSelection = hideTicketPopupKeepSelection;
window.showTicketPopup = showTicketPopup;
window.patchOpenTicketPopupDetail = patchOpenTicketPopupDetail;
window.ticketIdEquals = ticketIdEquals;
window.filterTickets = filterTickets;
window.selectTicketFromList = selectTicketFromList;
window.openTicketImporter = openTicketImporter;
window.closeTicketImporter = closeTicketImporter;
window.importTickets = importTickets;
window.deleteTicket = deleteTicket;
window.updateTicketAssignment = updateTicketAssignment;
window.openTicketAssigneesModal = openTicketAssigneesModal;
window.closeTicketAssigneesModal = closeTicketAssigneesModal;
window.submitTicketAssigneesModalSave = submitTicketAssigneesModalSave;
window.formatAssigneeCountLabel = formatAssigneeCountLabel;
window.getTicketOrganizationDisplayName = getTicketOrganizationDisplayName;
window.showTicketPhotos = showTicketPhotos;
window.closeTicketPhotosSideGallery = closeTicketPhotosSideGallery;

