/* Production service worker registration; disabled on local dev (see isLocalDevOrigin). */
(function () {
    var BOOT_TIMEOUT_MS = 4000;
    var BOOT_RELOAD_GUARD_MS = 10000;
    var UPDATE_CHECK_MS = 30 * 60 * 1000;
    var BUSY_POLL_MS = 30 * 1000;
    var RELOAD_AFTER_OVERLAY_MS = 1000;
    var BOOT_RELOAD_TS_KEY = 'pwaBootReloadTs';
    var DEV_SW_CLEAR_TS_KEY = 'pwaDevSwClearTs';
    var DEV_SW_CLEAR_GUARD_MS = 10000;

    var host = window.location.hostname;
    var isSecure =
        window.location.protocol === 'https:' ||
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '[::1]';
    var pwaSupported = 'serviceWorker' in navigator && isSecure;

    var reloadPending = false;
    var updateAvailable = false;
    var updateDeferred = false;
    var busyPollTimer = null;
    var lastUpdateCheck = 0;
    var hadControllerAtRegister = false;
    var bootPhaseComplete = false;
    var bootOverlayEl = null;
    var bootResolve = null;
    var bootTimeoutId = null;
    var bootUpdatePending = false;
    var appDataBootHeld = false;

    var BOOT_LOADER_SPANS = 3;

    function isLocalDevOrigin() {
        if (window.location.protocol === 'file:') return true;
        var h = window.location.hostname;
        return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
    }

    function recentlyDevSwCleared() {
        try {
            var raw = sessionStorage.getItem(DEV_SW_CLEAR_TS_KEY);
            if (!raw) return false;
            var ts = Number(raw);
            return Number.isFinite(ts) && Date.now() - ts < DEV_SW_CLEAR_GUARD_MS;
        } catch (_e) {
            return false;
        }
    }

    function markDevSwCleared() {
        try {
            sessionStorage.setItem(DEV_SW_CLEAR_TS_KEY, String(Date.now()));
        } catch (_e) {
            /* non-fatal */
        }
    }

    function recentlyBootReloaded() {
        try {
            var raw = sessionStorage.getItem(BOOT_RELOAD_TS_KEY);
            if (!raw) return false;
            var ts = Number(raw);
            return Number.isFinite(ts) && Date.now() - ts < BOOT_RELOAD_GUARD_MS;
        } catch (_e) {
            return false;
        }
    }

    function markBootReload() {
        try {
            sessionStorage.setItem(BOOT_RELOAD_TS_KEY, String(Date.now()));
        } catch (_e) {
            /* non-fatal */
        }
    }

    function clearBootTimeout() {
        if (bootTimeoutId != null) {
            clearTimeout(bootTimeoutId);
            bootTimeoutId = null;
        }
    }

    function buildBootLoaderHtml() {
        var spans = '';
        var i;
        for (i = 0; i < BOOT_LOADER_SPANS; i++) {
            spans += '<span></span>';
        }
        return (
            '<div class="app-loading-indicator app-loading-indicator--lg" aria-hidden="true">' +
            '<div class="ayw-loader ayw-loader--dipole ayw-loader--lg" aria-hidden="true">' +
            spans +
            '</div></div>'
        );
    }

    function isCoreBootProduct() {
        if (window.CORE_PRODUCT === true) return true;
        try {
            if (document.documentElement && document.documentElement.classList.contains('core-product')) {
                return true;
            }
        } catch (_e) {
            /* non-fatal */
        }
        return false;
    }

    function ensureBootOverlayStyles() {
        var styleId = 'pwaBootOverlayStyle';
        if (document.getElementById(styleId)) return;
        var core = isCoreBootProduct();
        var style = document.createElement('style');
        style.id = styleId;
        var shell =
            '#pwaBootOverlay{position:fixed;inset:0;z-index:2147483646;display:flex;' +
            'align-items:center;justify-content:center;';
        var themeColors;
        var labelExtra = '';
        var dipoleColor;
        if (core) {
            themeColors =
                'background:' +
                'radial-gradient(ellipse 70% 50% at 50% -10%,rgba(212,160,23,0.14),transparent 55%),' +
                'linear-gradient(180deg,rgba(11,13,16,0.55) 0%,rgba(11,13,16,0.92) 100%),' +
                '#0b0d10;color:#ece6d8;' +
                "font-family:'IBM Plex Sans','Segoe UI',system-ui,sans-serif}";
            labelExtra =
                'font-size:1.05rem;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;' +
                "font-family:'Barlow Condensed','Arial Narrow',sans-serif;color:#ece6d8;";
            dipoleColor = '#d4a017';
        } else {
            themeColors =
                'background:var(--app-bg-page,#1a1a1a);color:var(--app-text-primary,#e5e5e5);' +
                'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}';
            labelExtra = 'font-size:1rem;font-weight:500;letter-spacing:0.01em;color:var(--app-text-secondary,#a3a3a3);';
            dipoleColor = '#7ee0c8';
        }
        style.textContent =
            shell +
            themeColors +
            '#pwaBootOverlay .pwa-boot-inner{text-align:center;min-width:min(18rem,80vw)}' +
            '#pwaBootOverlay .app-loading-indicator{margin:0 auto 0.65rem}' +
            '#pwaBootOverlay .pwa-boot-label{' +
            labelExtra +
            '}' +
            '#pwaBootOverlay .ayw-loader{--ayw-loader-size:3rem;--ayw-loader-color:' +
            dipoleColor +
            ';display:inline-flex;align-items:center;justify-content:center;width:var(--ayw-loader-size);' +
            'height:var(--ayw-loader-size);position:relative;flex-shrink:0}' +
            '#pwaBootOverlay .ayw-loader--dipole{width:calc(var(--ayw-loader-size)*1.2);' +
            'animation:aywDipoleBreathe 1.4s ease-in-out infinite}' +
            '#pwaBootOverlay .ayw-loader--dipole>span:nth-child(1),' +
            '#pwaBootOverlay .ayw-loader--dipole>span:nth-child(2){position:absolute;top:8%;width:46%;height:84%;' +
            'box-sizing:border-box;border:calc(var(--ayw-loader-size)*0.055) solid var(--ayw-loader-color);' +
            'border-radius:50%}' +
            '#pwaBootOverlay .ayw-loader--dipole>span:nth-child(1){left:2%}' +
            '#pwaBootOverlay .ayw-loader--dipole>span:nth-child(2){right:2%}' +
            '#pwaBootOverlay .ayw-loader--dipole>span:nth-child(3){position:absolute;' +
            'width:calc(var(--ayw-loader-size)*0.14);height:calc(var(--ayw-loader-size)*0.14);' +
            'border-radius:50%;background:var(--ayw-loader-color);animation:aywDipoleCore 1.4s ease-in-out infinite}' +
            '@keyframes aywDipoleBreathe{0%,100%{transform:scaleX(.78) scaleY(1);opacity:.62}' +
            '50%{transform:scaleX(1) scaleY(.92);opacity:1}}' +
            '@keyframes aywDipoleCore{0%,100%{transform:scale(.75);opacity:.55}50%{transform:scale(1);opacity:1}}' +
            '@media (prefers-reduced-motion:reduce){#pwaBootOverlay .ayw-loader,' +
            '#pwaBootOverlay .ayw-loader>span{animation-duration:.01ms!important;animation-iteration-count:1!important}}';
        (document.head || document.documentElement).appendChild(style);
    }

    function showBootOverlay(opts) {
        opts = opts || {};
        var label = opts.label != null ? String(opts.label) : 'Loading…';

        if (bootOverlayEl) {
            var labelEl = bootOverlayEl.querySelector('.pwa-boot-label');
            if (labelEl) labelEl.textContent = label;
            return;
        }

        ensureBootOverlayStyles();

        bootOverlayEl = document.createElement('div');
        bootOverlayEl.id = 'pwaBootOverlay';
        bootOverlayEl.setAttribute('aria-busy', 'true');
        bootOverlayEl.setAttribute('aria-live', 'polite');
        bootOverlayEl.innerHTML =
            '<div class="pwa-boot-inner" role="status">' +
            buildBootLoaderHtml() +
            '<div class="pwa-boot-label">' +
            label +
            '</div>' +
            '</div>';
        document.documentElement.appendChild(bootOverlayEl);
    }

    function hideBootOverlay() {
        if (!bootOverlayEl) return;
        bootOverlayEl.remove();
        bootOverlayEl = null;
        var style = document.getElementById('pwaBootOverlayStyle');
        if (style) style.remove();
    }

    function setProgress() {
        /* Progress percent removed from the post-login overlay. */
    }

    function resetProgress() {
        /* no-op: kept for callers */
    }

    function retainForAppData() {
        appDataBootHeld = true;
        showBootOverlay();
    }

    function releaseAppDataBoot() {
        appDataBootHeld = false;
        if (!reloadPending) {
            hideBootOverlay();
        }
    }

    function isAppDataBootHeld() {
        return appDataBootHeld;
    }

    function finishBootGate() {
        if (bootPhaseComplete) return;
        clearBootTimeout();
        bootPhaseComplete = true;
        if (!appDataBootHeld && !reloadPending) {
            hideBootOverlay();
        }
        if (bootResolve) {
            bootResolve();
            bootResolve = null;
        }
    }

    window.pwaBootOverlay = {
        retainForAppData: retainForAppData,
        releaseAppDataBoot: releaseAppDataBoot,
        isAppDataBootHeld: isAppDataBootHeld,
        show: function (label) {
            showBootOverlay({ label: label != null ? label : 'Loading…' });
        },
        hide: function () {
            if (!reloadPending) hideBootOverlay();
        },
        setProgress: setProgress,
        resetProgress: resetProgress,
    };

    function reloadNow() {
        if (reloadPending) return;
        reloadPending = true;
        clearBusyPoll();
        window.location.reload();
    }

    function silentBootReload() {
        if (reloadPending || bootPhaseComplete) return;
        if (!navigator.serviceWorker.controller && !hadControllerAtRegister) return;
        if (recentlyBootReloaded()) {
            finishBootGate();
            return;
        }
        showBootOverlay();
        clearBootTimeout();
        markBootReload();
        window.setTimeout(reloadNow, RELOAD_AFTER_OVERLAY_MS);
    }

    function isInPageCameraOpen() {
        if (window.photosModule && typeof window.photosModule.isInPageCameraOverlayOpen === 'function') {
            return window.photosModule.isInPageCameraOverlayOpen();
        }
        var el = document.getElementById('inPageCameraOverlay');
        return !!(el && el.style.display !== 'none' && el.getAttribute('aria-hidden') !== 'true');
    }

    function isPhotoUploadInProgress() {
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
        return false;
    }

    function isAnnotating() {
        if (window.drawingModule && window.drawingModule.currentDrawingMode) return true;
        if (window.annotationsModule && window.annotationsModule.multiDrawActive) return true;
        var modal = document.getElementById('annotationModal');
        if (modal && modal.style.display !== 'none') return true;
        return false;
    }

    function isUserBusy() {
        if (isInPageCameraOpen()) return true;
        if (isPhotoUploadInProgress()) return true;
        if (window.photoUploadMode) return true;
        if (isAnnotating()) return true;
        if (window.submitJobPoller && typeof window.submitJobPoller.hasActiveOwnJobs === 'function') {
            if (window.submitJobPoller.hasActiveOwnJobs()) return true;
        }
        return false;
    }

    function clearBusyPoll() {
        if (busyPollTimer != null) {
            clearInterval(busyPollTimer);
            busyPollTimer = null;
        }
    }

    function showLoadingOverlayThenReload() {
        if (reloadPending) return;
        showBootOverlay();
        window.setTimeout(reloadNow, RELOAD_AFTER_OVERLAY_MS);
    }

    function scheduleUpdateReload() {
        if (reloadPending || !updateAvailable) return;

        if (!bootPhaseComplete) {
            silentBootReload();
            return;
        }

        if (isUserBusy()) {
            updateDeferred = true;
            if (busyPollTimer == null) {
                busyPollTimer = window.setInterval(function () {
                    if (reloadPending || !updateAvailable) {
                        clearBusyPoll();
                        updateDeferred = false;
                        return;
                    }
                    if (!isUserBusy()) {
                        updateDeferred = false;
                        clearBusyPoll();
                        showLoadingOverlayThenReload();
                    }
                }, BUSY_POLL_MS);
            }
            return;
        }

        updateDeferred = false;
        clearBusyPoll();
        showLoadingOverlayThenReload();
    }

    function nudgeWaitingWorker(worker) {
        if (!worker) return;
        try {
            worker.postMessage({ type: 'SKIP_WAITING' });
        } catch (_e) {
            /* non-fatal */
        }
    }

    function markUpdateAvailable() {
        if (!navigator.serviceWorker.controller && !hadControllerAtRegister) return;
        updateAvailable = true;
        bootUpdatePending = true;
        scheduleUpdateReload();
    }

    function watchInstallingWorker(worker) {
        if (!worker) return;
        worker.addEventListener('statechange', function () {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                markUpdateAvailable();
            }
        });
    }

    function checkForUpdate(reg, force) {
        if (!reg) return Promise.resolve();
        var now = Date.now();
        if (!force && now - lastUpdateCheck < UPDATE_CHECK_MS) return Promise.resolve();
        lastUpdateCheck = now;
        return reg.update().catch(function () {
            /* non-fatal */
        });
    }

    function onRegistration(reg) {
        hadControllerAtRegister = !!navigator.serviceWorker.controller;

        if (reg.waiting && navigator.serviceWorker.controller) {
            nudgeWaitingWorker(reg.waiting);
            markUpdateAvailable();
        }

        if (reg.installing) {
            watchInstallingWorker(reg.installing);
        }

        reg.addEventListener('updatefound', function () {
            watchInstallingWorker(reg.installing);
            if (reg.installing) {
                nudgeWaitingWorker(reg.installing);
            }
        });

        checkForUpdate(reg, true).finally(function () {
            if (!bootUpdatePending && !reloadPending) {
                finishBootGate();
            }
        });

        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') {
                checkForUpdate(reg, false);
            }
        });
        window.addEventListener('focus', function () {
            checkForUpdate(reg, false);
        });
        window.addEventListener('pageshow', function (ev) {
            if (ev.persisted) return;
            checkForUpdate(reg, true);
        });
    }

    navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (reloadPending) return;
        if (!navigator.serviceWorker.controller) return;
        if (!hadControllerAtRegister) return;
        updateAvailable = true;
        scheduleUpdateReload();
    });

    window.__pwaBootReady = new Promise(function (resolve) {
        bootResolve = resolve;
    });

    if (isLocalDevOrigin()) {
        window.__pwaBootReady = Promise.resolve();
        if ('serviceWorker' in navigator) {
            var hadController = !!navigator.serviceWorker.controller;
            void navigator.serviceWorker.getRegistrations().then(function (regs) {
                if (!regs.length) return;
                return Promise.all(
                    regs.map(function (reg) {
                        return reg.unregister();
                    }),
                ).then(function () {
                    if (hadController && !recentlyDevSwCleared()) {
                        markDevSwCleared();
                        window.location.reload();
                    }
                });
            });
        }
        return;
    }

    if (!pwaSupported) {
        window.__pwaBootReady = Promise.resolve();
        return;
    }

    showBootOverlay();
    bootTimeoutId = window.setTimeout(function () {
        if (!reloadPending) {
            finishBootGate();
        }
    }, BOOT_TIMEOUT_MS);

    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(onRegistration).catch(function () {
        finishBootGate();
    });
})();
