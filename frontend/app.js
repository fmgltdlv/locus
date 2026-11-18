// Main application initialization file
// This file coordinates all modules and initializes the application

const MAP_BOOT_PROGRESS = {
    mapReady: 10,
    org: 28,
    ticketsStart: 40,
    ticketsEnd: 100,
};

function setMapBootProgress(percent) {
    if (window.pwaBootOverlay && typeof window.pwaBootOverlay.setProgress === 'function') {
        window.pwaBootOverlay.setProgress(percent);
    }
}

function ticketBootProgressPercent(pageNum, hasMore) {
    const span = MAP_BOOT_PROGRESS.ticketsEnd - MAP_BOOT_PROGRESS.ticketsStart;
    const frac = hasMore && pageNum > 0 ? 1 - 1 / (pageNum + 1) : 1;
    return MAP_BOOT_PROGRESS.ticketsStart + span * frac;
}

// Initialize everything when DOM is ready
document.addEventListener('DOMContentLoaded', async function() {
    if (typeof window.ensureMapHubOverlaysOnBody === 'function') {
        window.ensureMapHubOverlaysOnBody();
    }

    if (window.authModule && window.authModule.isAuthenticated() && window.pwaBootOverlay) {
        window.pwaBootOverlay.retainForAppData();
    }

    if (window.__pwaBootReady) {
        await window.__pwaBootReady;
    }

    // Check authentication first
    if (!window.authModule || !window.authModule.isAuthenticated()) {
        if (window.pwaBootOverlay && typeof window.pwaBootOverlay.releaseAppDataBoot === 'function') {
            window.pwaBootOverlay.releaseAppDataBoot();
        }
        window.location.href = 'login.html';
        return;
    }

    // Public Worker tuning (cooperative lock ms for ticket refresh UI); non-blocking on failure
    if (typeof window.loadPublicWorkerConfig === 'function') {
        try {
            await window.loadPublicWorkerConfig();
        } catch (_e) {
            /* tickets-core uses built-in default */
        }
        if (typeof window.refreshGuidedTourButton === 'function') {
            window.refreshGuidedTourButton();
        }
    }

    // Refresh user from server so role (e.g. dev) is current
    try {
        if (window.authModule.refreshUser) {
            const user = await window.authModule.refreshUser();
            if (window.appI18n && user && user.preferredLanguage) {
                window.appI18n.setLanguage(user.preferredLanguage);
            }
        }
    } catch (e) {
        // Refresh failed, continue with cached user
    }

    if (typeof window.syncUserUiPreferencesFromServer === 'function') {
        try {
            await window.syncUserUiPreferencesFromServer();
        } catch (e) {
            console.warn('UI preferences sync:', e.message || e);
        }
    }

    if (window.mobilePinchZoomGuard && typeof window.mobilePinchZoomGuard.apply === 'function') {
        window.mobilePinchZoomGuard.apply(window.mobilePinchZoomGuard.readPreference());
    }

    if (window.overlayScrollModule?.attachOverlayScrollAll) {
        window.overlayScrollModule.attachOverlayScrollAll('.app-overlay-scroll');
    }

    initMap();
    
    // Wait for map to be ready before initializing other features
    if (!window.map) {
        console.error('Map not initialized after initMap()');
        return;
    }
    
    window.map.whenReady(async function() {
        setMapBootProgress(MAP_BOOT_PROGRESS.mapReady);

        // Initialize user-location tools (desktop toolbar toggle + mobile location button)
        if (typeof initMobileLiveLocationUI === 'function') {
            initMobileLiveLocationUI();
        }
        
        if (typeof window.initMapCircleMenus === 'function') {
            window.initMapCircleMenus();
        }
        if (typeof window.initMapTopLeftControls === 'function') {
            window.initMapTopLeftControls();
        }
        
        // Show admin menu item for appropriate users
        if (window.authModule && window.authModule.isAuthenticated()) {
            // Admin panel: show for admin or dev
            if (window.authModule.isAdmin() || window.authModule.isDev()) {
                const adminMenuItem = document.getElementById('adminPanelMenuItem');
                if (adminMenuItem) {
                    adminMenuItem.style.display = 'block';
                    adminMenuItem.removeAttribute('aria-hidden');
                }
            }
            if (typeof window.renderMapTopLeftLauncherBubbles === 'function') {
                window.renderMapTopLeftLauncherBubbles();
            }
        }
        
        // Initialize organization selector (await so ticket load uses correct org)
        if (typeof initOrgSelector === 'function') {
            await initOrgSelector();
        }
        if (window.CORE_PRODUCT !== true && typeof window.refreshDataHubDraftBadge === 'function') {
            void window.refreshDataHubDraftBadge();
        }
        if (window.usanOnboarding && typeof window.usanOnboarding.maybeShowUsanWelcomePopup === 'function') {
            try {
                await window.usanOnboarding.maybeShowUsanWelcomePopup();
            } catch (e) {
                console.warn('[usan-onboarding]', e);
            }
        }
        setMapBootProgress(MAP_BOOT_PROGRESS.org);
        if (typeof window.ensureOperatorResponseCodeCatalogLoaded === 'function') {
            try {
                await window.ensureOperatorResponseCodeCatalogLoaded();
            } catch (e) {
                console.warn('Operator response code catalog:', e.message || e);
            }
        }
        if (typeof window.updateEditPermissionsVisibility === 'function') {
            window.updateEditPermissionsVisibility();
        }
        
        // Update signOut to use auth module
        window.signOut = function() {
            if (typeof window.closeAccountMenu === 'function') {
                window.closeAccountMenu();
            }
            if (window.authModule && window.authModule.logout) {
                window.authModule.logout();
            } else {
                // Fallback
                localStorage.removeItem('authToken');
                localStorage.removeItem('currentUser');
                window.location.href = 'login.html';
            }
        };
        
        if (window.loadSettings) {
            window.loadSettings();
        }
        const profileData = typeof getUserProfile === 'function' ? getUserProfile() : {};
        if (profileData && Object.keys(profileData).length > 0 && typeof applyProfilePreferences === 'function') {
            applyProfilePreferences(profileData);
        }

        const coreProduct = window.CORE_PRODUCT === true;

        if (!coreProduct && window.annotationsModule) {
            await window.annotationsModule.loadAnnotations();
        }

        if (!coreProduct && typeof window.initAnnotationProximityPick === 'function') {
            window.initAnnotationProximityPick(window.map);
        }
        
        // Location + create-ticket toolbar (Core omits annotation draw buttons)
        if (window.drawingModule && window.drawingModule.initDrawingControls) {
            try {
                window.drawingModule.initDrawingControls();
            } catch (error) {
                console.error('Error initializing drawing controls:', error);
            }
        } else {
            console.error('Drawing module or initDrawingControls not available');
        }
        
        if (window.drawingModule && window.drawingModule.initSeparateControls) {
            try {
                window.drawingModule.initSeparateControls();
            } catch (error) {
                console.error('Error initializing separate controls:', error);
            }
        }

        if (typeof window.initMapToolsMobile === 'function') {
            try {
                window.initMapToolsMobile();
            } catch (error) {
                console.error('Error initializing mobile map tools:', error);
            }
        }
        
        if (!coreProduct && window.drawingModule && window.annotationsModule && window.annotationsModule.finishAnnotation) {
            window.drawingModule.setFinishAnnotationCallback(window.annotationsModule.finishAnnotation);
        }
        
        if (!coreProduct && window.measureModule) {
            window.measureModule.updateMeasureDisplay();
        }

        if (window.ticketsModule && window.ticketsModule.updateTicketsLayerControl) {
            window.ticketsModule.updateTicketsLayerControl();
        }
        if (!coreProduct && window.aerialMapsModule && window.aerialMapsModule.updateDroneMapsLayerControl) {
            window.aerialMapsModule.updateDroneMapsLayerControl();
        }
        if (typeof window.applyDefaultTicketStatusFromProfile === 'function') {
            window.applyDefaultTicketStatusFromProfile();
        }

        if (!coreProduct && window.photosModule) {
            window.photosModule.initPhotoViewerDrag();
            if (window.photosModule.initPhotosLayer) {
                window.photosModule.initPhotosLayer();
            }
            if (window.photoMapLoaderModule && typeof window.photoMapLoaderModule.initPhotoMapLoader === 'function') {
                window.photoMapLoaderModule.initPhotoMapLoader();
            }
            const bootOfflinePhotos =
                window.offlineModule && window.offlineModule.isOnline && !window.offlineModule.isOnline();
            if (bootOfflinePhotos && window.photosModule.reloadPhotosOnMap) {
                window.photosModule.reloadPhotosOnMap();
            } else if (
                window.photoMapLoaderModule &&
                typeof window.photoMapLoaderModule.scheduleFetchPhotoMapForViewport === 'function'
            ) {
                window.photoMapLoaderModule.scheduleFetchPhotoMapForViewport(false);
            }
        } else if (window.photosModule && window.photosModule.initPhotoViewerDrag) {
            window.photosModule.initPhotoViewerDrag();
        }

        if (!coreProduct && window.aerialMapPanelModule && window.aerialMapPanelModule.initWhenMapReady) {
            const bootOnlineAerial = !(window.offlineModule && window.offlineModule.isOnline && !window.offlineModule.isOnline());
            if (bootOnlineAerial) {
                setTimeout(() => {
                    window.aerialMapPanelModule.initWhenMapReady();
                }, 500);
            }
        }

        // Load tickets for current org (overlay held until 100% / Tickets)
        if (window.authModule && window.authModule.isAuthenticated()) {
            const bootOnline = !(window.offlineModule && window.offlineModule.isOnline && !window.offlineModule.isOnline());
            const syncPromise =
                bootOnline &&
                window.ticketsModule &&
                typeof window.ticketsModule.runIncrementalUsanListSyncChain === 'function'
                    ? window.ticketsModule.runIncrementalUsanListSyncChain()
                    : Promise.resolve();
            try {
                if (window.ticketsModule && typeof window.ticketsModule.loadTicketsForCurrentOrg === 'function') {
                    await window.ticketsModule.loadTicketsForCurrentOrg({
                        onBootProgress: function (info) {
                            const pageNum = info && info.pageNum != null ? Number(info.pageNum) : 0;
                            const hasMore = !!(info && info.hasMore);
                            setMapBootProgress(ticketBootProgressPercent(pageNum, hasMore));
                        },
                    });
                    setMapBootProgress(MAP_BOOT_PROGRESS.ticketsEnd);
                }
            } catch (error) {
                console.error('Error loading tickets from database:', error);
                const orgId =
                    window.orgSelectorModule && window.orgSelectorModule.getCurrentOrgId
                        ? window.orgSelectorModule.getCurrentOrgId()
                        : null;
                if (window.offlineModule && typeof window.offlineModule.hydrateTicketsFromIdb === 'function') {
                    await window.offlineModule.hydrateTicketsFromIdb(orgId);
                }
                if (window.ticketsModule && window.ticketsModule.renderTicketList) {
                    window.ticketsModule.renderTicketList();
                }
            } finally {
                if (window.pwaBootOverlay && typeof window.pwaBootOverlay.releaseAppDataBoot === 'function') {
                    window.pwaBootOverlay.releaseAppDataBoot();
                }
            }

            if (window.ticketsModule && typeof window.ticketsModule.zoomToAllTickets === 'function') {
                window.ticketsModule.zoomToAllTickets();
            }
            if (typeof window.ensureDesktopTicketHubOpen === 'function') {
                void window.ensureDesktopTicketHubOpen();
            }
            void syncPromise;

            if (!coreProduct) {
            try {
                if (!bootOnline) {
                    throw new Error('offline-skip-aerial');
                }
                if (window.aerialMapPanelModule && window.aerialMapPanelModule.prepareAerialViewRefetchAfterTickets) {
                    window.aerialMapPanelModule.prepareAerialViewRefetchAfterTickets();
                }
                let twSynced = false;
                if (window.aerialMapPanelModule && window.aerialMapPanelModule.syncAerialViewForZoom) {
                    twSynced = await window.aerialMapPanelModule.syncAerialViewForZoom();
                }
                if (!twSynced && window.aerialMapPanelModule && window.aerialMapPanelModule.refreshTimeWarpOnMap) {
                    await window.aerialMapPanelModule.refreshTimeWarpOnMap();
                }
                if (typeof window.applyAerialMapQueryFromUrl === 'function') {
                    let needAerialDeepLink = false;
                    try {
                        const p = new URLSearchParams(window.location.search);
                        const v = p.get('aerialMap');
                        needAerialDeepLink = v != null && String(v).trim() !== '';
                    } catch (_) {
                        /* ignore */
                    }
                    if (needAerialDeepLink && window.aerialMapsModule && window.aerialMapsModule.loadSavedAerialMaps) {
                        await window.aerialMapsModule.loadSavedAerialMaps();
                    }
                    window.applyAerialMapQueryFromUrl();
                }
            } catch (aerialErr) {
                console.error('Aerial follow-up after tickets:', aerialErr);
            }
            }
        } else if (window.pwaBootOverlay && typeof window.pwaBootOverlay.releaseAppDataBoot === 'function') {
            window.pwaBootOverlay.releaseAppDataBoot();
        }

        if (typeof window.initAppResume === 'function') {
            window.initAppResume();
        }

        if (!coreProduct && typeof window.maybeStartGuidedTour === 'function') {
            window.maybeStartGuidedTour();
        }
    });
});
