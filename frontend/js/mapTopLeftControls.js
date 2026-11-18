// Top-left map controls: org, Ticket Hub, account menu (desktop row; mobile FAB launcher).

(function () {
    'use strict';

    const MQ = window.matchMedia('(max-width: 768px)');
    const STAT_FILTER_LONG_PRESS_MS = 500;
    const STAT_FILTER_LONG_PRESS_MOVE_PX = 12;
    let launcherOpen = false;
    let statFilterMenuOpen = false;
    let statFilterPressState = null;
    let suppressStatBubbleClickUntil = 0;

    function isMobile() {
        return MQ.matches;
    }

    function launcherBackdrop() {
        return document.getElementById('mapTopLeftMenuBackdrop');
    }

    function launcherBubbles() {
        return document.getElementById('mapTopLeftMenuBubbles');
    }

    function launcherFab() {
        return document.getElementById('mapTopLeftMenuFab');
    }

    function statFilterMenu() {
        return document.getElementById('mapTopLeftStatFilterMenu');
    }

    function activeStatBubble() {
        return document.getElementById('mapTopLeftActiveStatBubble');
    }

    function dataHubFilterBubble() {
        return document.getElementById('mapTopLeftDataHubFilterBubble');
    }

    function clearStatFilterPressState() {
        if (statFilterPressState && statFilterPressState.timer) {
            clearTimeout(statFilterPressState.timer);
        }
        statFilterPressState = null;
    }

    function closeMapTopLeftStatFilterMenu() {
        statFilterMenuOpen = false;
        clearStatFilterPressState();
        const menu = statFilterMenu();
        const bubble = activeStatBubble();
        if (menu) {
            menu.classList.remove('map-top-left-stat-filter-menu--open');
            menu.hidden = true;
            menu.setAttribute('aria-hidden', 'true');
        }
        if (bubble) {
            bubble.setAttribute('aria-expanded', 'false');
        }
    }

    function openMapTopLeftStatFilterMenu() {
        if (!isMobile()) return;
        const menu = statFilterMenu();
        const bubble = activeStatBubble();
        if (!menu || !bubble || bubble.hidden) return;
        closeMapTopLeftLauncher();
        statFilterMenuOpen = true;
        menu.hidden = false;
        menu.classList.add('map-top-left-stat-filter-menu--open');
        menu.setAttribute('aria-hidden', 'false');
        bubble.setAttribute('aria-expanded', 'true');
        const cards = document.getElementById('mapTopLeftStatFilterCards');
        if (cards && !cards.childElementCount && typeof window.renderHubStats === 'function') {
            window.renderHubStats();
        }
    }

    function relocateProfileMenuToToolbar() {
        const wrap = document.querySelector('.profile-menu-button-wrap');
        const btn = document.getElementById('profileMenuButton');
        if (!wrap || !btn) return;
        btn.classList.add('map-toolbar-btn');
        btn.setAttribute('data-map-tool-label', 'Menu');
        if (isMobile()) {
            const topRight = document.getElementById('mapToolsMobileTopRight');
            if (topRight && wrap.parentNode !== topRight) {
                topRight.insertBefore(wrap, topRight.firstChild);
            }
            return;
        }
        const host = document.getElementById('mapToolbarAccountWrap') || window.mapToolbarBundleEl;
        if (host && wrap.parentNode !== host) {
            host.insertBefore(wrap, host.firstChild);
        }
    }

    function parkMapMenuFab() {
        const fab = launcherFab();
        const toolbar = document.querySelector('.map-top-left-toolbar');
        if (!fab) return;
        closeMapTopLeftLauncher();
        fab.hidden = true;
        fab.classList.remove('map-tools-mobile-top-right-btn', 'map-tools-mobile-top-right-btn--active');
        if (toolbar && fab.parentNode !== toolbar) {
            toolbar.appendChild(fab);
        }
    }

    function positionLauncherBubbles() {
        const fab = launcherFab();
        const bubbles = launcherBubbles();
        if (!fab || !bubbles) return;
        const rect = fab.getBoundingClientRect();
        const gap = 8;
        const spaceBelow = window.innerHeight - rect.bottom - gap;
        const estimatedHeight = Math.min(bubbles.scrollHeight || 280, window.innerHeight - 24);
        const openUp = spaceBelow < estimatedHeight && rect.top > spaceBelow;
        bubbles.style.left = 'auto';
        bubbles.style.right = Math.max(8, Math.round(window.innerWidth - rect.right)) + 'px';
        if (openUp) {
            bubbles.style.top = 'auto';
            bubbles.style.bottom = Math.max(8, Math.round(window.innerHeight - rect.top + gap)) + 'px';
        } else {
            bubbles.style.bottom = 'auto';
            bubbles.style.top = Math.round(rect.bottom + gap) + 'px';
        }
    }

    function closeMapTopLeftLauncher() {
        launcherOpen = false;
        const fab = launcherFab();
        const backdrop = launcherBackdrop();
        const bubbles = launcherBubbles();
        if (fab) {
            fab.classList.remove('map-top-left-menu-fab--open');
            fab.classList.remove('map-tools-mobile-top-right-btn--active');
            fab.setAttribute('aria-expanded', 'false');
        }
        if (backdrop) {
            backdrop.classList.remove('map-top-left-menu-backdrop--visible');
            backdrop.setAttribute('aria-hidden', 'true');
        }
        if (bubbles) {
            bubbles.classList.remove('map-top-left-menu-bubbles--open');
            bubbles.setAttribute('aria-hidden', 'true');
        }
    }

    function openMapTopLeftLauncher() {
        if (!isMobile()) return;
        closeMapTopLeftStatFilterMenu();
        launcherOpen = true;
        const fab = launcherFab();
        const backdrop = launcherBackdrop();
        const bubbles = launcherBubbles();
        if (fab) {
            fab.classList.add('map-top-left-menu-fab--open');
            fab.classList.add('map-tools-mobile-top-right-btn--active');
            fab.setAttribute('aria-expanded', 'true');
        }
        if (backdrop) {
            backdrop.classList.add('map-top-left-menu-backdrop--visible');
            backdrop.setAttribute('aria-hidden', 'false');
        }
        if (bubbles) {
            bubbles.classList.add('map-top-left-menu-bubbles--open');
            bubbles.setAttribute('aria-hidden', 'false');
            requestAnimationFrame(positionLauncherBubbles);
        }
    }

    function toggleMapTopLeftLauncher() {
        if (launcherOpen) closeMapTopLeftLauncher();
        else openMapTopLeftLauncher();
    }

    function escapeHtml(s) {
        if (s == null || s === '') return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function currentOrgForLauncher() {
        const mod = window.orgSelectorModule;
        return mod && mod.getCurrentOrganization ? mod.getCurrentOrganization() : null;
    }

    function orgLabelFor(org) {
        if (!org) return 'Organization';
        return org.publicCatalogDisplayName || org.name || 'Organization';
    }

    function orgHasMenuIcon(org) {
        if (!org) return false;
        return !!(org.menuIconUrl || (org.settings && org.settings.menuIconPath));
    }

    function orgMenuIconUrl(org) {
        if (!orgHasMenuIcon(org)) return null;
        const base = window.authModule && window.authModule.API_BASE ? window.authModule.API_BASE : null;
        if (!base) return null;
        return base + '/organizations/' + encodeURIComponent(String(org.id)) + '/menu-icon';
    }

    function launcherIcon(name, fallback) {
        if (window.mapIcons && typeof window.mapIcons.icon === 'function') {
            return window.mapIcons.icon(name, 20);
        }
        return fallback;
    }

    function launcherBubbleHtml(action, icon, label, extraClass) {
        const cls = extraClass ? ' map-top-left-launcher-bubble--' + extraClass : '';
        return (
            '<button type="button" class="map-top-left-launcher-bubble' +
            cls +
            '" data-launcher-action="' +
            action +
            '" aria-label="' +
            escapeHtml(label) +
            '">' +
            '<span class="map-top-left-launcher-bubble-icon" aria-hidden="true">' +
            icon +
            '</span>' +
            '<span class="map-top-left-launcher-bubble-label">' +
            escapeHtml(label) +
            '</span>' +
            '</button>'
        );
    }

    function launcherOrgBubbleHtml(org) {
        const name = orgLabelFor(org);
        const orgId = org && org.id != null ? org.id : '';
        const hasIcon = orgHasMenuIcon(org);
        const iconContent = hasIcon
            ? '<span class="map-top-left-launcher-bubble-icon-fallback" aria-hidden="true">◎</span>' +
              '<img class="map-top-left-launcher-bubble-icon-img" data-launcher-org-icon="' +
              escapeHtml(String(orgId)) +
              '" alt="" hidden />'
            : '◎';
        return launcherBubbleHtml('org', iconContent, name, 'org');
    }

    function hydrateLauncherOrgIcon() {
        const img = document.querySelector('img[data-launcher-org-icon]');
        if (!img || img.dataset.hydrated === '1') return;
        const orgId = img.getAttribute('data-launcher-org-icon');
        if (!orgId) return;
        const mod = window.orgSelectorModule;
        const orgs = mod && mod.getOrganizations ? mod.getOrganizations() : [];
        const org = orgs.find(function (o) {
            return String(o.id) === String(orgId);
        });
        if (!orgHasMenuIcon(org)) return;
        const url = orgMenuIconUrl(org);
        if (!url) return;
        img.dataset.hydrated = '1';
        const headers =
            window.authModule && window.authModule.getAuthHeaders ? window.authModule.getAuthHeaders() : {};
        const runFetch =
            window.authModule && typeof window.authModule.withApiConcurrency === 'function'
                ? function (fn) {
                      return window.authModule.withApiConcurrency(fn);
                  }
                : function (fn) {
                      return Promise.resolve().then(fn);
                  };
        void runFetch(function () {
            return fetch(url, { headers: headers });
        })
            .then(function (res) {
                if (!res.ok) throw new Error('icon');
                return res.blob();
            })
            .then(function (blob) {
                img.src = URL.createObjectURL(blob);
                img.hidden = false;
                const fallback =
                    img.parentElement &&
                    img.parentElement.querySelector('.map-top-left-launcher-bubble-icon-fallback');
                if (fallback) fallback.style.display = 'none';
            })
            .catch(function () {
                img.remove();
            });
    }

    function renderLauncherBubbles() {
        const el = launcherBubbles();
        if (!el) return;
        const admin = document.getElementById('adminPanelMenuItem');
        const showAdmin = admin && admin.style.display !== 'none';
        // Tickets entry is the top-left Tickets bubble (tap / long-press), not the hamburger.
        let html = '';
        if (window.CORE_PRODUCT !== true) {
            html += launcherBubbleHtml(
                'data-hub',
                window.mapIcons ? window.mapIcons.icon('dataHub', 20) : '📚',
                'Data Hub'
            );
        }
        html += launcherBubbleHtml('settings', launcherIcon('settings', '⚙'), 'Settings');
        if (showAdmin) {
            html += launcherBubbleHtml('admin', launcherIcon('adminPanel', '🛡'), 'Admin Panel');
        }
        html += launcherBubbleHtml('logout', '⎋', 'Logout', 'danger');
        el.innerHTML = html;
        hydrateLauncherOrgIcon();
        if (typeof window.applyAdminPanelMenuBadge === 'function') {
            window.applyAdminPanelMenuBadge();
        }
        if (typeof window.applyDataHubDraftBadge === 'function') {
            window.applyDataHubDraftBadge();
        }
    }

    function onLauncherAction(action) {
        closeMapTopLeftLauncher();
        if (action === 'org' && typeof window.openOrgCircleMenu === 'function') {
            window.openOrgCircleMenu();
        } else if (action === 'tickets' && typeof window.toggleTicketHubWindow === 'function') {
            window.toggleTicketHubWindow();
        } else if (action === 'tickets' && typeof window.openTicketHubWindow === 'function') {
            void window.openTicketHubWindow();
        } else if (action === 'data-hub' && typeof window.openDataWindow === 'function') {
            window.openDataWindow();
        } else if (action === 'about' || action === 'feedback') {
            return;
        } else if (typeof window.handleAccountMenuAction === 'function') {
            window.handleAccountMenuAction(action);
        }
    }

    function syncLayout() {
        const expanded = document.getElementById('mapTopLeftControlsExpanded');
        const fab = launcherFab();
        relocateProfileMenuToToolbar();
        if (!expanded || !fab) return;
        if (isMobile()) {
            expanded.hidden = true;
            // Account ☰ already lives in the top-right stack; the map-menu FAB was a second hamburger.
            parkMapMenuFab();
        } else {
            expanded.hidden = false;
            parkMapMenuFab();
            closeMapTopLeftStatFilterMenu();
        }
        if (typeof window.renderHubStats === 'function') {
            window.renderHubStats();
        } else if (typeof window.syncMapTopLeftActiveStatBubble === 'function') {
            window.syncMapTopLeftActiveStatBubble();
        }
        if (typeof window.syncDataHubMapFilterIndicator === 'function') {
            window.syncDataHubMapFilterIndicator();
        }
    }

    function openTicketHubFromBubble() {
        closeMapTopLeftLauncher();
        closeMapTopLeftStatFilterMenu();
        if (typeof window.toggleTicketHubWindow === 'function') {
            window.toggleTicketHubWindow();
            return;
        }
        if (typeof window.openTicketHubWindow === 'function') {
            void window.openTicketHubWindow();
        }
    }

    function openDataHubFromFilterBubble() {
        closeMapTopLeftLauncher();
        closeMapTopLeftStatFilterMenu();
        if (typeof window.openDataWindow !== 'function') return;
        let viewToOpen = null;
        const hub = window.dataHubFiltersModule;
        const lastView = window.dataWindowModule?.currentDataView;
        if (hub?.hasActiveFilters && lastView && hub.hasActiveFilters(lastView)) {
            viewToOpen = lastView;
        } else if (hub?.FILTER_VIEWS && hub.hasActiveFilters) {
            for (const v of hub.FILTER_VIEWS) {
                if (hub.hasActiveFilters(v)) {
                    viewToOpen = v;
                    break;
                }
            }
        }
        window.openDataWindow(viewToOpen || undefined);
    }

    function syncMapTopLeftDataHubFilterBubble(show) {
        const bubble = dataHubFilterBubble();
        if (!bubble) return;
        const visible = !!show && isMobile();
        bubble.hidden = !visible;
        bubble.classList.toggle('map-top-left-data-hub-filter-bubble--active', visible);
        const title = visible
            ? 'Data Hub — map filter active'
            : 'Data Hub';
        const ariaLabel = visible
            ? 'Data Hub — map filter active. Tap to open.'
            : 'Data Hub. Tap to open.';
        bubble.title = title;
        bubble.setAttribute('aria-label', ariaLabel);
    }

    function onActiveStatBubblePointerDown(e) {
        if (!isMobile()) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        // Feed org: tap opens Documentation feed; no contractor status long-press fan.
        if (typeof window.isTicketHubFeedMode === 'function' && window.isTicketHubFeedMode()) {
            return;
        }
        const bubble = activeStatBubble();
        if (!bubble || bubble.hidden) return;
        clearStatFilterPressState();
        const startX = e.clientX;
        const startY = e.clientY;
        statFilterPressState = {
            pointerId: e.pointerId,
            startX: startX,
            startY: startY,
            fired: false,
            timer: setTimeout(function () {
                if (!statFilterPressState) return;
                statFilterPressState.fired = true;
                suppressStatBubbleClickUntil = Date.now() + 800;
                openMapTopLeftStatFilterMenu();
                if (navigator.vibrate) {
                    try {
                        navigator.vibrate(10);
                    } catch (_) {
                        /* ignore */
                    }
                }
            }, STAT_FILTER_LONG_PRESS_MS),
        };
        try {
            bubble.setPointerCapture(e.pointerId);
        } catch (_) {
            /* ignore */
        }
    }

    function onActiveStatBubblePointerMove(e) {
        if (!statFilterPressState || statFilterPressState.pointerId !== e.pointerId) return;
        const dx = e.clientX - statFilterPressState.startX;
        const dy = e.clientY - statFilterPressState.startY;
        if (Math.hypot(dx, dy) > STAT_FILTER_LONG_PRESS_MOVE_PX) {
            clearStatFilterPressState();
        }
    }

    function onActiveStatBubblePointerUp(e) {
        if (!statFilterPressState || statFilterPressState.pointerId !== e.pointerId) return;
        const fired = statFilterPressState.fired;
        clearStatFilterPressState();
        if (fired) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    function onActiveStatBubbleClick(e) {
        e.stopPropagation();
        if (Date.now() < suppressStatBubbleClickUntil) {
            e.preventDefault();
            return;
        }
        openTicketHubFromBubble();
    }

    function initMapTopLeftControls() {
        renderLauncherBubbles();
        syncLayout();

        const orgBtn = document.getElementById('orgMenuButton');
        const profileBtn = document.getElementById('profileMenuButton');
        const fab = launcherFab();
        const backdrop = launcherBackdrop();
        const bubbles = launcherBubbles();
        const activeBubble = activeStatBubble();
        const dataHubBubble = dataHubFilterBubble();
        const filterClose = document.getElementById('mapTopLeftStatFilterClose');

        if (orgBtn) {
            orgBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                if (typeof window.openOrgCircleMenu === 'function') {
                    if (document.getElementById('orgCircleMenu')?.classList.contains('map-circle-menu--open')) {
                        if (typeof window.closeAllCircleMenus === 'function') window.closeAllCircleMenus();
                    } else {
                        window.openOrgCircleMenu();
                    }
                }
            });
        }

        if (profileBtn) {
            profileBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                if (typeof window.openAccountMenuToggle === 'function') window.openAccountMenuToggle();
            });
        }

        if (fab) {
            fab.addEventListener('click', function (e) {
                e.stopPropagation();
                toggleMapTopLeftLauncher();
            });
        }

        if (activeBubble) {
            activeBubble.addEventListener('pointerdown', onActiveStatBubblePointerDown);
            activeBubble.addEventListener('pointermove', onActiveStatBubblePointerMove);
            activeBubble.addEventListener('pointerup', onActiveStatBubblePointerUp);
            activeBubble.addEventListener('pointercancel', clearStatFilterPressState);
            activeBubble.addEventListener('click', onActiveStatBubbleClick);
            activeBubble.addEventListener('contextmenu', function (e) {
                e.preventDefault();
            });
        }

        if (dataHubBubble) {
            dataHubBubble.addEventListener('click', function (e) {
                e.stopPropagation();
                openDataHubFromFilterBubble();
            });
        }

        if (filterClose) {
            filterClose.addEventListener('click', function (e) {
                e.stopPropagation();
                closeMapTopLeftStatFilterMenu();
            });
        }

        if (backdrop) {
            backdrop.addEventListener('click', closeMapTopLeftLauncher);
        }

        if (bubbles) {
            bubbles.addEventListener('click', function (e) {
                const btn = e.target.closest('[data-launcher-action]');
                if (!btn) return;
                onLauncherAction(btn.getAttribute('data-launcher-action'));
            });
        }

        if (typeof MQ.addEventListener === 'function') {
            MQ.addEventListener('change', syncLayout);
        } else if (typeof MQ.addListener === 'function') {
            MQ.addListener(syncLayout);
        }
        window.addEventListener('resize', function () {
            if (launcherOpen) positionLauncherBubbles();
        });

        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            if (statFilterMenuOpen) {
                closeMapTopLeftStatFilterMenu();
                return;
            }
            if (launcherOpen) closeMapTopLeftLauncher();
        });
    }

    function updateOrgMenuButtonLabel() {
        const btn = document.getElementById('orgMenuButton');
        const labelEl = document.getElementById('orgMenuButtonLabel');
        const org = currentOrgForLauncher();
        const name = orgLabelFor(org);
        if (btn && labelEl) {
            labelEl.textContent = name;
            btn.title = name;
        }
        // Rebuilding bubbles on every org switch fans out menu-icon GETs; refresh only when open.
        if (launcherOpen) {
            renderLauncherBubbles();
        }
    }

    window.initMapTopLeftControls = initMapTopLeftControls;
    window.relocateProfileMenuToToolbar = relocateProfileMenuToToolbar;
    window.openMapTopLeftLauncher = openMapTopLeftLauncher;
    window.closeMapTopLeftLauncher = closeMapTopLeftLauncher;
    window.closeMapTopLeftStatFilterMenu = closeMapTopLeftStatFilterMenu;
    window.openMapTopLeftStatFilterMenu = openMapTopLeftStatFilterMenu;
    window.updateOrgMenuButtonLabel = updateOrgMenuButtonLabel;
    window.renderMapTopLeftLauncherBubbles = renderLauncherBubbles;
    window.syncMapTopLeftDataHubFilterBubble = syncMapTopLeftDataHubFilterBubble;
})();
