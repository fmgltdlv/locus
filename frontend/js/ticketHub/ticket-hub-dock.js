/**
 * Desktop Ticket Hub: fixed left sidebar. Ticket detail pops out as a sheet
 * attached to the list (does not widen the sidebar).
 */
(function (global) {
    'use strict';

    const PIN_LIST_WIDTH = 548;
    const PIN_DETAIL_WIDTH = 760;
    const PIN_MIN_WIDTH = 320;
    const PIN_MAP_GUTTER = 240;
    const PIN_MAX_WIDTH = 920;
    const DOCK_CLASSES = [
        'ticket-hub-window--dock-bottom',
        'ticket-hub-window--dock-float',
        'ticket-hub-window--dock-left',
        'ticket-hub-window--dock-right',
        'ticket-hub-window--dock-minimized',
    ];

    let currentMode = 'pinLeft';
    let dockResize = null;
    let docHandlersBound = false;

    function isDesktop() {
        return typeof isTicketHubMobile === 'function' ? !isTicketHubMobile() : window.innerWidth > 768;
    }

    function hubEl() {
        return document.getElementById('ticketHubWindow');
    }

    function mapContainerEl() {
        return document.querySelector('.map-container');
    }

    function profileKey() {
        let storageKey = 'userProfile';
        if (global.authModule && global.authModule.isAuthenticated && global.authModule.isAuthenticated()) {
            const user = global.authModule.getCurrentUser();
            if (user && user.id) storageKey = 'userProfile_user_' + user.id;
        }
        return storageKey;
    }

    function readProfile() {
        try {
            return JSON.parse(localStorage.getItem(profileKey()) || '{}');
        } catch (_e) {
            return {};
        }
    }

    function writeProfile(patch) {
        try {
            const data = readProfile();
            Object.keys(patch).forEach(function (k) {
                data[k] = patch[k];
            });
            localStorage.setItem(profileKey(), JSON.stringify(data));
            if (typeof global.schedulePersistUserUiPreferencesToServer === 'function') {
                global.schedulePersistUserUiPreferencesToServer();
            }
        } catch (e) {
            console.error(e);
        }
    }

    function invalidateMap() {
        const map = global.map;
        if (map && typeof map.invalidateSize === 'function') {
            requestAnimationFrame(function () {
                map.invalidateSize({ animate: false });
            });
        }
    }

    function clearMapInset() {
        const mc = mapContainerEl();
        if (!mc) return;
        mc.style.removeProperty('--ticket-hub-dock-inset-left');
        mc.style.removeProperty('--ticket-hub-dock-inset-right');
        invalidateMap();
    }

    function applyMapInset(widthPx) {
        const mc = mapContainerEl();
        if (!mc) return;
        mc.style.setProperty('--ticket-hub-dock-inset-left', Math.round(widthPx) + 'px');
        mc.style.setProperty('--ticket-hub-dock-inset-right', '0px');
        invalidateMap();
    }

    function stripDockClasses(el) {
        DOCK_CLASSES.forEach(function (c) {
            el.classList.remove(c);
        });
    }

    function maxSidebarWidth() {
        return Math.max(PIN_MIN_WIDTH, Math.min(PIN_MAX_WIDTH, window.innerWidth - PIN_MAP_GUTTER));
    }

    function desiredWidth(hasDetail) {
        const maxW = maxSidebarWidth();
        const p = readProfile();
        const saved = Number(hasDetail ? p.ticketHubSidebarDetailWidth : p.ticketHubSidebarListWidth);
        const fallback = hasDetail ? PIN_DETAIL_WIDTH : PIN_LIST_WIDTH;
        let w = Number.isFinite(saved) && saved >= PIN_MIN_WIDTH ? saved : fallback;
        if (!hasDetail && w < PIN_LIST_WIDTH) w = PIN_LIST_WIDTH;
        return Math.max(PIN_MIN_WIDTH, Math.min(maxW, w));
    }

    function hideChip() {
        const chip = document.getElementById('ticketHubDockChip');
        if (chip) chip.hidden = true;
    }

    function setDockHandleHidden(h, hide) {
        if (!h) return;
        h.hidden = !!hide;
        h.style.display = hide ? 'none' : '';
        h.setAttribute('aria-hidden', hide ? 'true' : 'false');
    }

    function ensurePinHandle(el) {
        let h = el.querySelector('[data-hub-dock-resize="pin"]');
        if (!h) {
            h = document.createElement('div');
            h.className = 'ticket-hub-dock-resize ticket-hub-dock-resize--pin';
            h.setAttribute('data-hub-dock-resize', 'pin');
            el.appendChild(h);
        }
        h.setAttribute('data-hub-dock-pin-side', 'left');
    }

    function syncDockResizeHandles(el) {
        if (!el) return;
        const pinMode = isDesktop() && el.classList.contains('show');
        el.querySelectorAll(
            '[data-hub-dock-resize="right"], [data-hub-dock-resize="bottom"], [data-hub-dock-resize="corner"]'
        ).forEach(function (h) {
            setDockHandleHidden(h, true);
        });
        setDockHandleHidden(el.querySelector('[data-hub-dock-resize="pin"]'), !pinMode);
    }

    function syncTopResizeHandle(el) {
        const top = el && el.querySelector('#ticketHubResizeHandleTop, .ticket-hub-resize-top');
        if (!top) return;
        top.style.display = 'none';
        top.setAttribute('aria-hidden', 'true');
    }

    function syncDockBtnUi() {
        const btn = document.getElementById('ticketHubDockBtn');
        if (btn) btn.hidden = true;
    }

    function applyPin(el) {
        stripDockClasses(el);
        el.classList.add('ticket-hub-window--dock-left');
        const hasDetail = el.classList.contains('ticket-hub-window--has-detail');
        const width = desiredWidth(hasDetail);
        el.style.setProperty('--ticket-hub-sidebar-width', width + 'px');
        el.style.width = width + 'px';
        el.style.height = '100%';
        el.style.maxHeight = '100%';
        el.style.top = '0';
        el.style.bottom = '0';
        el.style.left = '0';
        el.style.right = '';
        el.style.transform = 'none';
        applyMapInset(width);
        hideChip();
        ensurePinHandle(el);
        syncDockResizeHandles(el);
    }

    function applyCurrent() {
        const el = hubEl();
        if (!el) return;
        currentMode = 'pinLeft';
        if (!isDesktop()) {
            stripDockClasses(el);
            el.classList.remove('ticket-hub-window--has-detail');
            clearMapInset();
            hideChip();
            syncDockResizeHandles(el);
            syncTopResizeHandle(el);
            syncDockBtnUi();
            return;
        }
        applyPin(el);
        syncTopResizeHandle(el);
        syncDockBtnUi();
    }

    function setExpanded(expanded) {
        const el = hubEl();
        if (!el) return;
        el.classList.toggle('ticket-hub-window--has-detail', !!expanded);
        if (!isDesktop() || !el.classList.contains('show')) return;
        applyPin(el);
    }

    function setMode(_mode) {
        currentMode = 'pinLeft';
        applyCurrent();
    }

    function onHubClosed() {
        hideChip();
        clearMapInset();
        const el = hubEl();
        if (el) {
            el.classList.remove('ticket-hub-window--has-detail');
            stripDockClasses(el);
            el.querySelectorAll('[data-hub-dock-resize]').forEach(function (h) {
                setDockHandleHidden(h, true);
            });
        }
    }

    function onHubOpened() {
        applyCurrent();
    }

    function shouldKeepOpenOnMapClick() {
        return isDesktop();
    }

    function getMode() {
        return 'pinLeft';
    }

    function saveGeometry(el) {
        if (!el || !isDesktop()) return;
        const rect = el.getBoundingClientRect();
        const key = el.classList.contains('ticket-hub-window--has-detail')
            ? 'ticketHubSidebarDetailWidth'
            : 'ticketHubSidebarListWidth';
        const patch = {};
        patch[key] = Math.round(rect.width);
        writeProfile(patch);
    }

    function bindDocHandlers() {
        if (docHandlersBound) return;
        docHandlersBound = true;
        document.addEventListener('mousemove', function (e) {
            const el = hubEl();
            if (!el || !dockResize) return;
            let width = e.clientX;
            const maxW = maxSidebarWidth();
            width = Math.max(PIN_MIN_WIDTH, Math.min(maxW, width));
            el.style.setProperty('--ticket-hub-sidebar-width', width + 'px');
            el.style.width = width + 'px';
            applyMapInset(width);
        });
        document.addEventListener('mouseup', function () {
            const el = hubEl();
            if (dockResize) {
                if (el) saveGeometry(el);
                if (typeof hubSuppressOutsideCloseUntil !== 'undefined') {
                    hubSuppressOutsideCloseUntil = Date.now() + 400;
                }
            }
            dockResize = null;
            if (el) el.classList.remove('resizing');
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
        });
        window.addEventListener('resize', function () {
            const el = hubEl();
            if (!el || !el.classList.contains('show') || !isDesktop()) return;
            applyCurrent();
        });
    }

    function initHubDock() {
        const el = hubEl();
        bindDocHandlers();
        if (el && el.dataset.hubDockDragInit !== '1') {
            el.dataset.hubDockDragInit = '1';
            el.addEventListener('mousedown', function (e) {
                if (!isDesktop()) return;
                const resizeEl = e.target.closest('[data-hub-dock-resize]');
                if (!resizeEl || resizeEl.getAttribute('data-hub-dock-resize') !== 'pin') return;
                e.preventDefault();
                e.stopPropagation();
                dockResize = { type: 'pin' };
                el.classList.add('resizing');
                document.body.style.userSelect = 'none';
            });
        }
        syncDockBtnUi();
    }

    global.ticketHubDockModule = {
        init: initHubDock,
        setMode: setMode,
        setExpanded: setExpanded,
        getMode: getMode,
        applyCurrent: applyCurrent,
        onHubOpened: onHubOpened,
        onHubClosed: onHubClosed,
        shouldKeepOpenOnMapClick: shouldKeepOpenOnMapClick,
        restoreFromChip: function () {},
    };
})(typeof window !== 'undefined' ? window : globalThis);
