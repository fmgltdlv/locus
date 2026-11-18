/**
 * Numeric draft-count badge on Data Hub (map button, mobile launcher, Reported Events tab).
 */
(function () {
    'use strict';

    var DATA_HUB_OPEN_BUTTON_DEFAULT_TITLE =
        'Data Hub: annotations, layers, photos, documents, and events';
    var EVENTS_TAB_LABEL = 'Reported Events';
    var LAUNCHER_BADGE_CLASS = 'data-hub-draft-badge';

    function formatBadgeCount(n) {
        var count = Number(n);
        if (!Number.isFinite(count) || count <= 0) return '';
        return count > 99 ? '99+' : String(count);
    }

    function setBadgeCount(badge, count) {
        if (!badge) return;
        var text = formatBadgeCount(count);
        if (text) {
            badge.hidden = false;
            badge.setAttribute('aria-hidden', 'false');
            badge.textContent = text;
        } else {
            badge.hidden = true;
            badge.textContent = '';
            badge.setAttribute('aria-hidden', 'true');
        }
    }

    function draftCountFromStore() {
        var store = window.reportedEventsStore;
        if (!store || typeof store.countDrafts !== 'function') return 0;
        var n = Number(store.countDrafts());
        return Number.isFinite(n) && n > 0 ? n : 0;
    }

    function isHubFilterActive() {
        var hubBtn = document.getElementById('dataHubOpenButton');
        return !!(hubBtn && hubBtn.classList.contains('map-top-left-hub-btn--map-filtered'));
    }

    function buildHubButtonLabel(draftCount, filterActive) {
        var parts = [];
        if (draftCount > 0) {
            parts.push(draftCount + ' draft reported event' + (draftCount === 1 ? '' : 's'));
        }
        if (filterActive) {
            parts.push('map filter active');
        }
        if (!parts.length) return DATA_HUB_OPEN_BUTTON_DEFAULT_TITLE;
        return 'Data Hub — ' + parts.join(', ');
    }

    function ensureLauncherBadge(btn) {
        var host = btn.querySelector('.map-top-left-launcher-bubble-icon') || btn;
        var badge = host.querySelector('.' + LAUNCHER_BADGE_CLASS);
        if (!badge) {
            badge = document.createElement('span');
            badge.className = LAUNCHER_BADGE_CLASS;
            badge.setAttribute('aria-hidden', 'true');
            badge.hidden = true;
            host.appendChild(badge);
        }
        return badge;
    }

    function applyOpenButton(count) {
        var hubBtn = document.getElementById('dataHubOpenButton');
        var badge = document.getElementById('dataHubOpenButtonBadge');
        setBadgeCount(badge, count);
        if (hubBtn) {
            hubBtn.classList.toggle('map-top-left-hub-btn--has-draft-badge', count > 0);
            var label = buildHubButtonLabel(count, isHubFilterActive());
            hubBtn.title = label;
            hubBtn.setAttribute('aria-label', label);
        }
    }

    function applyLauncher(count) {
        var btn = document.querySelector('[data-launcher-action="data-hub"]');
        if (!btn) return;
        setBadgeCount(ensureLauncherBadge(btn), count);
        var label = count > 0 ? 'Data Hub — ' + count + ' draft reported event' + (count === 1 ? '' : 's') : 'Data Hub';
        btn.setAttribute('aria-label', label);
    }

    function applyEventsTab(count) {
        var tab = document.getElementById('dataViewEvents');
        var badge = document.getElementById('dataViewEventsBadge');
        setBadgeCount(badge, count);
        if (tab) {
            tab.setAttribute(
                'aria-label',
                count > 0
                    ? EVENTS_TAB_LABEL + ' — ' + count + ' draft' + (count === 1 ? '' : 's')
                    : EVENTS_TAB_LABEL
            );
        }
        var sel = document.getElementById('dataViewDropdown');
        if (!sel) return;
        var opt = sel.querySelector('option[value="events"]');
        if (!opt) return;
        var shown = formatBadgeCount(count);
        opt.textContent = shown ? EVENTS_TAB_LABEL + ' (' + shown + ')' : EVENTS_TAB_LABEL;
    }

    var paintedCount = 0;
    var paintedOrgId = null;

    function currentOrgId() {
        if (typeof window.getCurrentOrgId === 'function') {
            var v = window.getCurrentOrgId();
            return v != null && v !== '' ? Number(v) : null;
        }
        return null;
    }

    function applyDataHubDraftBadge() {
        if (!window.authModule || !window.authModule.isAuthenticated()) {
            paintedCount = 0;
            paintedOrgId = null;
            applyOpenButton(0);
            applyLauncher(0);
            applyEventsTab(0);
            return;
        }
        var orgId = currentOrgId();
        if (orgId !== paintedOrgId) {
            paintedCount = 0;
            paintedOrgId = orgId;
        }
        var store = window.reportedEventsStore;
        if (store && typeof store.hasFreshCache === 'function' && store.hasFreshCache()) {
            paintedCount = draftCountFromStore();
        }
        applyOpenButton(paintedCount);
        applyLauncher(paintedCount);
        applyEventsTab(paintedCount);
    }

    function refreshDataHubDraftBadge() {
        if (!window.authModule || !window.authModule.isAuthenticated()) {
            applyDataHubDraftBadge();
            return Promise.resolve();
        }
        var store = window.reportedEventsStore;
        if (!store || typeof store.ensureLoaded !== 'function') {
            applyDataHubDraftBadge();
            return Promise.resolve();
        }
        return Promise.resolve(store.ensureLoaded())
            .then(function () {
                applyDataHubDraftBadge();
            })
            .catch(function () {
                applyDataHubDraftBadge();
            });
    }

    document.addEventListener('DOMContentLoaded', function () {
        void refreshDataHubDraftBadge();
    });

    window.applyDataHubDraftBadge = applyDataHubDraftBadge;
    window.refreshDataHubDraftBadge = refreshDataHubDraftBadge;
})();
