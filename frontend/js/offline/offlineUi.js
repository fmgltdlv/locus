/**
 * Offline top-left indicator, reconnect sync spinner, staleness tooltip, and action gating helpers.
 */
(function () {
    'use strict';

    var INDICATOR_ID = 'locusOfflineIndicator';
    var STYLE_ID = 'locusOfflineUiStyle';
    var syncActiveCount = 0;

    function formatStaleness(ts) {
        if (ts == null || !Number.isFinite(ts)) return '';
        if (typeof window.formatRecordedDateTime === 'function') {
            return window.formatRecordedDateTime(ts, '');
        }
        return '';
    }

    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent =
            '.locus-offline-disabled{opacity:0.45!important;pointer-events:none!important;cursor:not-allowed!important}' +
            '.locus-pending-sync-badge{display:inline-block;margin-left:0.35rem;padding:0.1rem 0.4rem;' +
            'border-radius:999px;background:rgba(255,200,80,0.25);font-size:0.72rem;vertical-align:middle}';
        (document.head || document.documentElement).appendChild(style);
    }

    function offlineIconSvg() {
        return (
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<line x1="1" y1="1" x2="23" y2="23"></line>' +
            '<path d="M16.72 11.06A10.94 10.94 0 0 1 19 12"></path>' +
            '<path d="M5 12.55a11 11 0 0 1 14.08 0"></path>' +
            '<path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path>' +
            '<line x1="12" y1="20" x2="12.01" y2="20"></line>' +
            '</svg>'
        );
    }

    function syncSpinnerHtml() {
        return '<span class="map-top-left-reconnect-sync-spinner" aria-hidden="true"></span>';
    }

    function isMobileToolbar() {
        return window.matchMedia('(max-width: 768px)').matches;
    }

    function shouldUseStatusBarConnectivitySlot() {
        return false;
    }

    function pushConnectivityToStatusIndicator() {
        /* USAN activity indicator removed. */
    }

    function placeIndicator(el) {
        if (!el) return;
        if (isMobileToolbar()) {
            var toolbar = document.querySelector('.map-top-left-toolbar');
            if (toolbar) {
                if (el.parentNode !== toolbar || toolbar.lastElementChild !== el) {
                    toolbar.appendChild(el);
                }
                return;
            }
        }
        var expanded = document.getElementById('mapTopLeftControlsExpanded');
        if (expanded) {
            if (el.parentNode !== expanded || expanded.lastElementChild !== el) {
                expanded.appendChild(el);
            }
        }
    }

    function ensureIndicator() {
        ensureStyles();
        var el = document.getElementById(INDICATOR_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = INDICATOR_ID;
            el.className = 'map-top-left-offline-indicator';
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'polite');
            el.setAttribute('aria-label', 'Offline — showing cached data');
            el.hidden = true;
            el.innerHTML = offlineIconSvg();
        }
        placeIndicator(el);
        return el;
    }

    async function buildOfflineTooltip() {
        var lines = ['Offline — showing cached data'];
        if (window.offlineStore) {
            try {
                var orgId =
                    window.orgSelectorModule && window.orgSelectorModule.getCurrentOrgId
                        ? window.orgSelectorModule.getCurrentOrgId()
                        : null;
                var meta = await window.offlineStore.getSyncMeta(orgId);
                if (meta && meta.lastTicketSyncAt) {
                    lines.push('Tickets last downloaded: ' + formatStaleness(meta.lastTicketSyncAt));
                }
            } catch (_e) {
                /* non-fatal */
            }
        }
        return lines.join('\n');
    }

    async function updateIndicatorDisplay() {
        var conn = window.offlineConnectivity;
        var online = conn && conn.isOnline ? conn.isOnline() : true;
        var indicator = ensureIndicator();
        var tip = '';

        if (!online) {
            document.documentElement.classList.add('locus-offline-mode');
            tip = await buildOfflineTooltip();
            pushConnectivityToStatusIndicator(false, tip);

            if (shouldUseStatusBarConnectivitySlot()) {
                indicator.hidden = true;
                indicator.classList.remove('map-top-left-offline-indicator--syncing');
                return;
            }

            indicator.classList.remove('map-top-left-offline-indicator--syncing');
            indicator.innerHTML = offlineIconSvg();
            indicator.hidden = false;
            indicator.setAttribute('title', tip);
            indicator.setAttribute('aria-label', tip.split('\n')[0] || 'Offline');
            indicator.setAttribute('aria-busy', 'false');
            return;
        }

        document.documentElement.classList.remove('locus-offline-mode');
        pushConnectivityToStatusIndicator(true, '');

        if (shouldUseStatusBarConnectivitySlot()) {
            indicator.hidden = true;
            indicator.classList.remove('map-top-left-offline-indicator--syncing');
            return;
        }

        if (syncActiveCount > 0) {
            indicator.classList.add('map-top-left-offline-indicator--syncing');
            indicator.innerHTML = syncSpinnerHtml();
            indicator.hidden = false;
            indicator.setAttribute('title', 'Syncing offline changes…');
            indicator.setAttribute('aria-label', 'Syncing data');
            indicator.setAttribute('aria-busy', 'true');
            return;
        }

        indicator.classList.remove('map-top-left-offline-indicator--syncing');
        indicator.innerHTML = offlineIconSvg();
        indicator.hidden = true;
        indicator.removeAttribute('title');
        indicator.setAttribute('aria-label', 'Offline — showing cached data');
        indicator.setAttribute('aria-busy', 'false');
    }

    function refreshBanner() {
        void updateIndicatorDisplay();
    }

    function setReconnectSyncing(active) {
        if (active) {
            syncActiveCount += 1;
        } else {
            syncActiveCount = Math.max(0, syncActiveCount - 1);
        }
        void updateIndicatorDisplay();
    }

    function shouldDisableMutations() {
        var conn = window.offlineConnectivity;
        return !!(conn && conn.isOnline && !conn.isOnline());
    }

    function applyOfflineDisabled(el, disabled, title) {
        if (!el) return;
        if (disabled) {
            el.classList.add('locus-offline-disabled');
            el.setAttribute('aria-disabled', 'true');
            if (title) el.setAttribute('title', title);
            if (el.tagName === 'BUTTON' || el.tagName === 'INPUT') el.disabled = true;
        } else {
            el.classList.remove('locus-offline-disabled');
            el.removeAttribute('aria-disabled');
            if (title && el.getAttribute('title') === title) el.removeAttribute('title');
            if (el.tagName === 'BUTTON' || el.tagName === 'INPUT') el.disabled = false;
        }
    }

    function guardOfflineAction(message) {
        if (!shouldDisableMutations()) return false;
        var msg = message || 'This action requires an internet connection.';
        if (typeof window.appAlert === 'function') {
            void window.appAlert(msg);
        }
        return true;
    }

    async function getPendingSyncCounts() {
        if (!window.offlineStore) return { photos: 0, notes: 0 };
        try {
            var uploads = await window.offlineStore.listPendingUploads();
            var notes = await window.offlineStore.listPendingNotes();
            return {
                photos: uploads.length,
                notes: notes.length,
            };
        } catch (_e) {
            return { photos: 0, notes: 0 };
        }
    }

    function updateAccountMenuPendingLabel() {
        var el = document.getElementById('offlineSyncStatusMenuItem');
        if (!el) return;
        void getPendingSyncCounts().then(function (c) {
            var total = c.photos + c.notes;
            if (!total) {
                el.style.display = 'none';
                el.textContent = '';
                return;
            }
            el.style.display = 'block';
            var parts = [];
            if (c.photos) parts.push(c.photos + ' photo' + (c.photos === 1 ? '' : 's'));
            if (c.notes) parts.push(c.notes + ' note' + (c.notes === 1 ? '' : 's'));
            el.textContent = 'Pending sync: ' + parts.join(', ');
        });
    }

    if (window.offlineConnectivity && window.offlineConnectivity.onConnectivityChange) {
        window.offlineConnectivity.onConnectivityChange(function () {
            refreshBanner();
            updateAccountMenuPendingLabel();
        });
    }

    if (typeof window.matchMedia === 'function') {
        var mq = window.matchMedia('(max-width: 768px)');
        var onMq = function () {
            var el = document.getElementById(INDICATOR_ID);
            if (el) placeIndicator(el);
            void updateIndicatorDisplay();
        };
        if (typeof mq.addEventListener === 'function') {
            mq.addEventListener('change', onMq);
        } else if (typeof mq.addListener === 'function') {
            mq.addListener(onMq);
        }
    }

    window.offlineUi = {
        refreshBanner: refreshBanner,
        setReconnectSyncing: setReconnectSyncing,
        shouldDisableMutations: shouldDisableMutations,
        applyOfflineDisabled: applyOfflineDisabled,
        guardOfflineAction: guardOfflineAction,
        getPendingSyncCounts: getPendingSyncCounts,
        updateAccountMenuPendingLabel: updateAccountMenuPendingLabel,
    };
})();
