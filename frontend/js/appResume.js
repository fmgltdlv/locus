/**
 * Foreground / bfcache resume: fix Leaflet layout and refresh stale ticket data (15 min threshold).
 */
(function () {
    'use strict';

    var RESUME_REFRESH_THRESHOLD_MS = 15 * 60 * 1000;
    var RESUME_DEBOUNCE_MS = 500;

    var debounceTimer = null;
    var initialized = false;

    function isUserBusyForResume() {
        if (window.photosModule && typeof window.photosModule.isInPageCameraOverlayOpen === 'function') {
            if (window.photosModule.isInPageCameraOverlayOpen()) return true;
        }
        var cam = document.getElementById('inPageCameraOverlay');
        if (cam && cam.style.display !== 'none' && cam.getAttribute('aria-hidden') !== 'true') return true;

        if (window.photosModule && typeof window.photosModule.hasActivePhotoUploadWork === 'function') {
            if (window.photosModule.hasActivePhotoUploadWork()) return true;
        }
        var status = document.getElementById('photoUploadStatus');
        if (status && status.style.display !== 'none') {
            if (
                !status.classList.contains('photo-upload-status-success') &&
                !status.classList.contains('photo-upload-status-error')
            ) {
                return true;
            }
        }
        if (window.photoUploadMode) return true;
        if (window.drawingModule && window.drawingModule.currentDrawingMode) return true;
        if (window.annotationsModule && window.annotationsModule.multiDrawActive) return true;
        var modal = document.getElementById('annotationModal');
        if (modal && modal.style.display !== 'none') return true;
        if (window.submitJobPoller && typeof window.submitJobPoller.hasActiveOwnJobs === 'function') {
            if (window.submitJobPoller.hasActiveOwnJobs()) return true;
        }
        return false;
    }

    function getCurrentOrgId() {
        if (window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function') {
            return window.orgSelectorModule.getCurrentOrgId();
        }
        var user = window.authModule && window.authModule.getCurrentUser && window.authModule.getCurrentUser();
        return user && user.organizationId != null ? user.organizationId : null;
    }

    function getLastTicketSyncMs() {
        var tm = window.ticketsModule;
        if (!tm || typeof tm.getLastTicketsFullLoadAtForOrg !== 'function') return null;
        var ts = tm.getLastTicketsFullLoadAtForOrg(getCurrentOrgId());
        return typeof ts === 'number' && Number.isFinite(ts) ? ts : null;
    }

    function fixMapLayout() {
        var map = window.map;
        if (map && typeof map.invalidateSize === 'function') {
            requestAnimationFrame(function () {
                map.invalidateSize({ animate: false });
            });
        }
    }

    function isOnline() {
        return typeof navigator === 'undefined' || navigator.onLine !== false;
    }

    async function refreshStaleDataIfNeeded() {
        if (!window.authModule || !window.authModule.isAuthenticated()) return;

        if (isOnline()) {
            if (window.offlineSync && typeof window.offlineSync.flushAllOutboxes === 'function') {
                void window.offlineSync.flushAllOutboxes();
            } else if (window.photosModule && typeof window.photosModule.flushPendingMediaDeletes === 'function') {
                void window.photosModule.flushPendingMediaDeletes();
            }
        }

        if (!isOnline()) return;
        if (isUserBusyForResume()) return;

        var lastSync = getLastTicketSyncMs();
        if (lastSync == null) return;

        var staleMs = Date.now() - lastSync;
        if (staleMs < RESUME_REFRESH_THRESHOLD_MS) return;

        var tm = window.ticketsModule;
        if (!tm || typeof tm.loadTicketsForCurrentOrg !== 'function') return;

        var orgId = getCurrentOrgId();
        if (typeof tm.isTicketsLoadInFlightForOrg === 'function' && tm.isTicketsLoadInFlightForOrg(orgId)) {
            return;
        }

        try {
            await tm.loadTicketsForCurrentOrg({ preserveSelection: true });
        } catch (e) {
            console.warn('[appResume] ticket refresh:', e.message || e);
            return;
        }

        if (typeof tm.runIncrementalUsanListSyncChain === 'function') {
            void tm.runIncrementalUsanListSyncChain();
        }

        if (window.photosModule) {
            try {
                if (typeof window.photosModule.invalidateManageDataPhotosSync === 'function') {
                    window.photosModule.invalidateManageDataPhotosSync();
                }
                if (typeof window.photosModule.ensureManageDataPhotosLoaded === 'function') {
                    await window.photosModule.ensureManageDataPhotosLoaded();
                }
            } catch (e) {
                console.warn('[appResume] photos reload:', e.message || e);
            }
            if (window.photoMapLoaderModule && typeof window.photoMapLoaderModule.onAppVisibleAfterResume === 'function') {
                window.photoMapLoaderModule.onAppVisibleAfterResume();
            } else if (typeof window.photosModule.reloadPhotosOnMap === 'function') {
                window.photosModule.reloadPhotosOnMap();
            }
        }

        if (window.ticketHubModule && typeof window.ticketHubModule.redrawIfOpen === 'function') {
            window.ticketHubModule.redrawIfOpen();
        }
    }

    function handleAppVisible() {
        if (document.visibilityState && document.visibilityState !== 'visible') return;
        fixMapLayout();
        if (debounceTimer != null) clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(function () {
            debounceTimer = null;
            void refreshStaleDataIfNeeded();
        }, RESUME_DEBOUNCE_MS);
    }

    function initAppResume() {
        if (initialized) return;
        initialized = true;

        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') {
                handleAppVisible();
            } else if (document.visibilityState === 'hidden') {
                if (
                    window.photoMapLoaderModule &&
                    typeof window.photoMapLoaderModule.onAppHidden === 'function'
                ) {
                    window.photoMapLoaderModule.onAppHidden();
                }
            }
        });

        window.addEventListener('pageshow', function () {
            handleAppVisible();
            if (typeof window.renderHubStats === 'function') {
                window.renderHubStats();
            }
        });
    }

    window.initAppResume = initAppResume;
})();
