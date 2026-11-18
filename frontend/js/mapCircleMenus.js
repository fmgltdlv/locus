// Org + account circle bubble menus (shared backdrop, fan toward screen center).

(function () {
    'use strict';

    let openMenuKind = null; // 'org' | 'account' | null
    /** @type {Map<string, string>} orgId → object URL for menu icon blob */
    const orgMenuIconBlobUrlByOrgId = new Map();

    const ORG_RADIAL_MAX = 5;
    const ORG_LIST_PAGE_SIZE = 6;
    let orgListPickerState = { query: '', page: 1 };

    function escapeHtml(s) {
        if (s == null || s === '') return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** Hub windows are siblings of `.map-container` (z-index 1); overlays must be on `body` to stack above them. */
    function ensureMapHubOverlaysOnBody() {
        [
            'mapCircleMenuBackdrop',
            'orgCircleMenu',
            'accountCircleMenu',
            'mapStatusFilters',
        ].forEach(function (id) {
            const el = document.getElementById(id);
            if (!el || !document.body) return;
            document.body.appendChild(el);
        });
    }

    function backdropEl() {
        return document.getElementById('mapCircleMenuBackdrop');
    }

    function orgMenuEl() {
        return document.getElementById('orgCircleMenu');
    }

    function accountMenuEl() {
        return document.getElementById('accountCircleMenu');
    }

    function orgLabelFor(org) {
        if (!org) return 'Organization';
        return org.publicCatalogDisplayName || org.name || 'Organization';
    }

    function closeAllCircleMenus() {
        openMenuKind = null;
        const backdrop = backdropEl();
        const orgMenu = orgMenuEl();
        const accountMenu = accountMenuEl();
        if (backdrop) {
            backdrop.classList.remove('map-circle-menu-backdrop--visible');
            backdrop.setAttribute('aria-hidden', 'true');
        }
        if (orgMenu) {
            orgMenu.classList.remove('map-circle-menu--open', 'map-org-list-menu');
            orgMenu.classList.add('map-org-radial-menu');
            orgMenu.style.removeProperty('left');
            orgMenu.style.removeProperty('top');
            orgMenu.style.removeProperty('transform');
            orgMenu.setAttribute('aria-hidden', 'true');
        }
        orgListPickerState = { query: '', page: 1 };
        if (accountMenu) {
            accountMenu.classList.remove('map-circle-menu--open');
            accountMenu.setAttribute('aria-hidden', 'true');
        }
        const orgBtn = document.getElementById('orgMenuButton');
        const profileBtn = document.getElementById('profileMenuButton');
        if (orgBtn) orgBtn.setAttribute('aria-expanded', 'false');
        if (profileBtn) profileBtn.setAttribute('aria-expanded', 'false');
    }

    function positionCircleMenu(menuEl) {
        if (!menuEl) return;
        const anchor =
            document.getElementById('mapTopLeftControls') ||
            document.getElementById('orgMenuButton') ||
            document.getElementById('profileMenuButton');
        if (!anchor) return;
        const rect = anchor.getBoundingClientRect();
        menuEl.style.left = Math.round(rect.left) + 'px';
        menuEl.style.top = Math.round(rect.bottom + 8) + 'px';
    }

    function bubbleMenuIcon(name, fallback) {
        if (window.mapIcons && typeof window.mapIcons.icon === 'function') {
            return window.mapIcons.icon(name, window.mapIcons.TOOLBAR_SIZE);
        }
        return fallback;
    }

    function bubbleButton(label, icon, opts) {
        const o = opts || {};
        const active = o.active ? ' map-circle-menu-bubble--active' : '';
        const danger = o.danger ? ' map-circle-menu-bubble--danger' : '';
        const greeting = o.greeting ? ' map-circle-menu-bubble--greeting' : '';
        const action = o.action != null ? ' data-action="' + escapeHtml(o.action) + '"' : '';
        const ariaCurrent = o.active ? ' aria-current="true"' : '';
        return (
            '<button type="button" class="map-circle-menu-bubble' +
            active +
            danger +
            greeting +
            '"' +
            action +
            ' role="menuitem"' +
            ariaCurrent +
            '>' +
            '<span class="map-circle-menu-bubble-icon" aria-hidden="true">' +
            icon +
            '</span>' +
            '<span class="map-circle-menu-bubble-label">' +
            escapeHtml(label) +
            '</span>' +
            '</button>'
        );
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

    function orgIconInnerHtml(org) {
        if (!orgHasMenuIcon(org)) {
            return '◎';
        }
        return (
            '<span class="map-org-radial-item-icon-fallback" aria-hidden="true">◎</span>' +
            '<img class="map-org-radial-item-img" data-org-menu-icon="' +
            escapeHtml(String(org.id)) +
            '" alt="" hidden />'
        );
    }

    function getOrgRadialMeasureHost() {
        let host = document.getElementById('orgRadialMeasureHost');
        if (!host) {
            host = document.createElement('div');
            host.id = 'orgRadialMeasureHost';
            host.className = 'map-org-radial-measure-host';
            host.setAttribute('aria-hidden', 'true');
            document.body.appendChild(host);
        }
        return host;
    }

    function computeOrgRadialLayout(orgs, hubName, currentOrg, orgCount) {
        const host = getOrgRadialMeasureHost();
        const hasIcon = !!currentOrg;
        host.innerHTML =
            '<div class="map-org-radial-hub map-org-radial-hub--measure">' +
            (hasIcon ? '<span class="map-org-radial-hub-icon" aria-hidden="true">◎</span>' : '') +
            '<span class="map-org-radial-hub-caption">Current Organization</span>' +
            '<span class="map-org-radial-hub-name">' +
            escapeHtml(hubName) +
            '</span></div>';
        const measuredHub = host.querySelector('.map-org-radial-hub');
        const hubSize = Math.min(
            280,
            Math.max(140, Math.ceil(Math.max(measuredHub.offsetWidth, measuredHub.offsetHeight)))
        );

        let maxStackW = 0;
        let maxStackOutward = 0;
        const stackMeasureClass =
            orgCount > 10
                ? ' map-org-radial-wheel--count-many'
                : orgCount > 6
                  ? ' map-org-radial-wheel--count-medium'
                  : '';
        orgs.forEach(function (org) {
            let label = orgLabelFor(org);
            if (org.accessMode === 'viewer') label += ' (view)';
            host.innerHTML =
                '<div class="map-org-radial-wheel map-org-radial-item-stack--measure-wrap' +
                stackMeasureClass +
                '"><span class="map-org-radial-item-stack map-org-radial-item-stack--measure">' +
                '<span class="map-org-radial-item-icon" aria-hidden="true">◎</span>' +
                '<span class="map-org-radial-item-label">' +
                escapeHtml(label) +
                '</span></span></div>';
            const stack = host.querySelector('.map-org-radial-item-stack');
            maxStackW = Math.max(maxStackW, stack.offsetWidth);
            const iconHalf = orgCount > 10 ? 18 : orgCount > 6 ? 21 : 24;
            maxStackOutward = Math.max(maxStackOutward, stack.offsetHeight - iconHalf);
        });

        const iconHalf = orgCount > 10 ? 18 : orgCount > 6 ? 21 : 24;
        const iconSize = iconHalf * 2;
        let tangentialMinR = 0;
        if (orgCount > 1) {
            const stepRad = (2 * Math.PI) / orgCount;
            tangentialMinR = Math.ceil((maxStackW + 16) / (2 * Math.sin(stepRad / 2)));
        }
        const radialRadius = Math.max(
            148,
            Math.ceil(hubSize / 2 + iconHalf + maxStackOutward + 16),
            tangentialMinR
        );
        const radialCap = Math.round(window.innerWidth * 0.44);
        const radius = Math.min(radialCap, radialRadius);
        const menuSize = Math.min(
            Math.round(window.innerWidth * 0.92),
            Math.max(420, Math.ceil(radius * 2 + maxStackW + maxStackOutward + 32))
        );

        return {
            hubSize: hubSize,
            radialRadius: radius,
            menuSize: menuSize
        };
    }

    function orgRadialWheelStyle(layout) {
        return (
            '--org-hub-size:' +
            layout.hubSize +
            'px;--radial-radius:' +
            layout.radialRadius +
            'px;--org-menu-size:' +
            layout.menuSize +
            'px'
        );
    }

    function applyOrgMenuIconToImg(img, blobUrl) {
        if (!img || !blobUrl) return;
        img.src = blobUrl;
        img.hidden = false;
        const fallback = img.parentElement && img.parentElement.querySelector('.map-org-radial-item-icon-fallback');
        if (fallback) fallback.style.display = 'none';
    }

    function hydrateOrgMenuIconImages(root) {
        // Only hydrate while the org radial menu is open — closed rebuilds must not fan out icon GETs.
        if (openMenuKind !== 'org') return;
        const scope = root || document;
        const imgs = scope.querySelectorAll('img[data-org-menu-icon]');
        const mod = window.orgSelectorModule;
        const orgs = mod && mod.getOrganizations ? mod.getOrganizations() : [];
        const runFetch =
            window.authModule && typeof window.authModule.withApiConcurrency === 'function'
                ? function (fn) {
                      return window.authModule.withApiConcurrency(fn);
                  }
                : function (fn) {
                      return Promise.resolve().then(fn);
                  };
        imgs.forEach(function (img) {
            const orgId = img.getAttribute('data-org-menu-icon');
            if (!orgId || img.dataset.hydrated === '1') return;
            const org = orgs.find(function (o) {
                return String(o.id) === String(orgId);
            });
            if (!orgHasMenuIcon(org)) return;
            const cached = orgMenuIconBlobUrlByOrgId.get(String(orgId));
            if (cached) {
                img.dataset.hydrated = '1';
                applyOrgMenuIconToImg(img, cached);
                return;
            }
            const url = orgMenuIconUrl(org);
            if (!url) return;
            img.dataset.hydrated = '1';
            const headers =
                window.authModule && window.authModule.getAuthHeaders ? window.authModule.getAuthHeaders() : {};
            void runFetch(function () {
                return fetch(url, { headers: headers }).then(function (res) {
                    if (!res.ok) throw new Error('icon');
                    return res.blob();
                });
            })
                .then(function (blob) {
                    const prev = orgMenuIconBlobUrlByOrgId.get(String(orgId));
                    if (prev) {
                        try {
                            URL.revokeObjectURL(prev);
                        } catch (e) {
                            /* ignore */
                        }
                    }
                    const blobUrl = URL.createObjectURL(blob);
                    orgMenuIconBlobUrlByOrgId.set(String(orgId), blobUrl);
                    applyOrgMenuIconToImg(img, blobUrl);
                })
                .catch(function () {
                    img.remove();
                });
        });
    }

    /**
     * Rebuild radial menu HTML only when the org menu is open (avoids icon fetch storms on every org switch).
     * Callers that only need the title-bar / launcher updated should use updateOrgMenuButtonLabel instead.
     */
    function renderOrgCircleMenuIfOpen() {
        if (openMenuKind === 'org') renderOrgCircleMenu();
    }

    function normalizeOrgListQuery(value) {
        return String(value || '').trim().toLowerCase();
    }

    function orgMatchesListQuery(org, query) {
        if (!query) return true;
        const label = orgLabelFor(org);
        if (label.toLowerCase().includes(query)) return true;
        if (org.name && String(org.name).toLowerCase().includes(query)) return true;
        if (org.publicCatalogDisplayName && String(org.publicCatalogDisplayName).toLowerCase().includes(query)) {
            return true;
        }
        if (org.id != null && String(org.id).includes(query)) return true;
        return false;
    }

    function getFilteredSortedOrgs(orgs) {
        const query = normalizeOrgListQuery(orgListPickerState.query);
        const sorted = (Array.isArray(orgs) ? orgs.slice() : []).sort(function (a, b) {
            return orgLabelFor(a).localeCompare(orgLabelFor(b), undefined, { sensitivity: 'base' });
        });
        if (!query) return sorted;
        return sorted.filter(function (org) {
            return orgMatchesListQuery(org, query);
        });
    }

    function getOrgListPageForOrg(orgs, orgId, query) {
        const prevQuery = orgListPickerState.query;
        orgListPickerState.query = query != null ? query : prevQuery;
        const filtered = getFilteredSortedOrgs(orgs);
        orgListPickerState.query = prevQuery;
        const idx = filtered.findIndex(function (o) {
            return Number(o.id) === Number(orgId);
        });
        if (idx < 0) return 1;
        return Math.floor(idx / ORG_LIST_PAGE_SIZE) + 1;
    }

    function applyOrgFeedBadge(menu, orgs) {
        if (
            !menu ||
            !window.feedMapLayerModule ||
            typeof window.feedMapLayerModule.getFeedOpenCount !== 'function'
        ) {
            return;
        }
        const feedCount = window.feedMapLayerModule.getFeedOpenCount();
        if (feedCount == null || feedCount <= 0) return;
        const feedOrg = orgs.find(function (o) {
            return o && o.isDevTicketHub;
        });
        if (!feedOrg) return;
        const btn = menu.querySelector('[data-action="org:' + feedOrg.id + '"]');
        let badgeHost = null;
        if (btn) {
            badgeHost = btn.querySelector('.map-org-list-item-icon, .map-org-radial-item-stack');
        } else {
            badgeHost = menu.querySelector('.map-org-list-header-name');
        }
        if (!badgeHost) return;
        const badge = document.createElement('span');
        badge.className = 'map-org-radial-feed-badge';
        badge.textContent = String(feedCount);
        badge.title = feedCount + ' open documentation feed items';
        badgeHost.appendChild(badge);
    }

    function orgListItemRow(org, currentId) {
        const label = orgLabelFor(org);
        const suffix = org.accessMode === 'viewer' ? ' (view)' : '';
        const active = Number(org.id) === Number(currentId);
        return (
            '<button type="button" class="map-org-list-item' +
            (active ? ' map-org-list-item--active' : '') +
            '" data-action="org:' +
            org.id +
            '" role="menuitemradio" aria-checked="' +
            (active ? 'true' : 'false') +
            '" title="' +
            escapeHtml(label + suffix) +
            '">' +
            '<span class="map-org-list-item-icon" aria-hidden="true">' +
            orgIconInnerHtml(org) +
            '</span>' +
            '<span class="map-org-list-item-label">' +
            escapeHtml(label + suffix) +
            '</span>' +
            (active ? '<span class="map-org-list-item-check" aria-hidden="true">✓</span>' : '') +
            '</button>'
        );
    }

    function renderOrgListMenu(menu, orgs, currentId, currentOrg) {
        const activeEl = document.activeElement;
        const searchHadFocus = !!(activeEl && activeEl.classList && activeEl.classList.contains('map-org-list-search'));
        const selStart = searchHadFocus && typeof activeEl.selectionStart === 'number' ? activeEl.selectionStart : null;
        const selEnd = searchHadFocus && typeof activeEl.selectionEnd === 'number' ? activeEl.selectionEnd : null;

        menu.classList.remove('map-org-radial-menu');
        menu.classList.add('map-org-list-menu');
        menu.style.removeProperty('--org-menu-size');
        menu.style.removeProperty('transform');

        const hubName = currentOrg ? orgLabelFor(currentOrg) : 'Organization';
        const filtered = getFilteredSortedOrgs(orgs);
        const total = filtered.length;
        const totalPages = Math.max(1, Math.ceil(total / ORG_LIST_PAGE_SIZE) || 1);
        let page = Math.max(1, Math.floor(Number(orgListPickerState.page) || 1));
        if (page > totalPages) page = totalPages;
        orgListPickerState.page = page;

        const usePagination = total > ORG_LIST_PAGE_SIZE;
        const start = usePagination ? (page - 1) * ORG_LIST_PAGE_SIZE : 0;
        const pageItems = usePagination ? filtered.slice(start, start + ORG_LIST_PAGE_SIZE) : filtered;

        let itemsBlockHtml = '';
        if (total === 0) {
            const emptyMsg =
                normalizeOrgListQuery(orgListPickerState.query) !== ''
                    ? 'No organizations match your search.'
                    : 'No organizations';
            itemsBlockHtml =
                '<div class="map-org-list-empty" role="status">' + escapeHtml(emptyMsg) + '</div>';
        } else {
            itemsBlockHtml =
                '<div class="map-org-list-items app-overlay-scroll" role="menu" aria-label="Organization choices">' +
                pageItems
                    .map(function (org) {
                        return orgListItemRow(org, currentId);
                    })
                    .join('') +
                '</div>';
        }

        let paginationHtml = '';
        if (usePagination) {
            const rangeStart = total === 0 ? 0 : start + 1;
            const rangeEnd = total === 0 ? 0 : start + pageItems.length;
            const prevDisabled = page <= 1 ? ' disabled' : '';
            const nextDisabled = page >= totalPages ? ' disabled' : '';
            paginationHtml =
                '<div class="map-org-list-pagination">' +
                '<span class="map-org-list-pagination-summary">Showing ' +
                rangeStart +
                '–' +
                rangeEnd +
                ' of ' +
                total +
                '</span>' +
                '<span class="map-org-list-pagination-controls">' +
                '<button type="button" class="map-org-list-page-btn" data-org-list-page="prev" aria-label="Previous page"' +
                prevDisabled +
                '>Previous</button>' +
                '<span class="map-org-list-pagination-page">Page ' +
                page +
                ' of ' +
                totalPages +
                '</span>' +
                '<button type="button" class="map-org-list-page-btn" data-org-list-page="next" aria-label="Next page"' +
                nextDisabled +
                '>Next</button>' +
                '</span></div>';
        }

        menu.innerHTML =
            '<div class="map-org-list-panel" aria-label="Organizations">' +
            '<div class="map-org-list-header">' +
            '<span class="map-org-list-header-caption">Current organization</span>' +
            '<span class="map-org-list-header-name">' +
            escapeHtml(hubName) +
            '</span></div>' +
            '<div class="map-org-list-search-wrap">' +
            '<input type="search" class="map-org-list-search" placeholder="Search organizations…" aria-label="Search organizations" value="' +
            escapeHtml(orgListPickerState.query) +
            '" autocomplete="off" spellcheck="false" />' +
            '</div>' +
            itemsBlockHtml +
            paginationHtml +
            '</div>';

        hydrateOrgMenuIconImages(menu);
        applyOrgFeedBadge(menu, orgs);

        if (searchHadFocus) {
            const search = menu.querySelector('.map-org-list-search');
            if (search) {
                search.focus();
                if (selStart != null && selEnd != null && typeof search.setSelectionRange === 'function') {
                    search.setSelectionRange(selStart, selEnd);
                }
            }
        }

        syncOrgListOverlayScroll(menu);
    }

    function syncOrgListOverlayScroll(menu) {
        if (!menu || !window.overlayScrollModule) return;
        const scrollEl = menu.querySelector('.map-org-list-items.app-overlay-scroll');
        if (!scrollEl) return;
        if (typeof window.overlayScrollModule.ensureOverlayScroll === 'function') {
            window.overlayScrollModule.ensureOverlayScroll(scrollEl);
        } else if (typeof window.overlayScrollModule.attachOverlayScroll === 'function') {
            window.overlayScrollModule.attachOverlayScroll(scrollEl);
            if (typeof window.overlayScrollModule.syncOverlayScroll === 'function') {
                window.overlayScrollModule.syncOverlayScroll(scrollEl);
            }
        }
    }

    function renderOrgRadialMenu(menu, orgs, currentId, currentOrg) {
        menu.classList.remove('map-org-list-menu');
        menu.classList.add('map-org-radial-menu');
        menu.style.removeProperty('left');
        menu.style.removeProperty('top');

        const hubName = currentOrg ? orgLabelFor(currentOrg) : 'Organization';
        const hubIconHtml = currentOrg
            ? '<span class="map-org-radial-hub-icon" aria-hidden="true">' + orgIconInnerHtml(currentOrg) + '</span>'
            : '';
        const count = orgs.length;
        const countClass =
            count > 10 ? ' map-org-radial-wheel--count-many' : count > 6 ? ' map-org-radial-wheel--count-medium' : '';
        let itemsHtml = '';
        if (count === 0) {
            itemsHtml =
                '<button type="button" class="map-org-radial-item map-org-radial-item--solo" data-action="noop" disabled>' +
                '<span class="map-org-radial-item-orbit">' +
                '<span class="map-org-radial-item-stack">' +
                '<span class="map-org-radial-item-label">No organizations</span></span></span></button>';
        } else {
            itemsHtml = orgs
                .map(function (org, i) {
                    return radialOrgItem(org, i, count, currentId);
                })
                .join('');
        }
        const layout = computeOrgRadialLayout(orgs, hubName, currentOrg, count);
        menu.style.setProperty('--org-menu-size', layout.menuSize + 'px');
        menu.innerHTML =
            '<div class="map-org-radial-wheel' +
            countClass +
            '" role="menu" aria-label="Organizations" style="' +
            orgRadialWheelStyle(layout) +
            '">' +
            '<div class="map-org-radial-ring" aria-hidden="true"></div>' +
            '<div class="map-org-radial-hub" aria-hidden="true">' +
            hubIconHtml +
            '<span class="map-org-radial-hub-caption">Current Organization</span>' +
            '<span class="map-org-radial-hub-name">' +
            escapeHtml(hubName) +
            '</span>' +
            '</div>' +
            '<div class="map-org-radial-items">' +
            itemsHtml +
            '</div>' +
            '</div>';
        hydrateOrgMenuIconImages(menu);
        applyOrgFeedBadge(menu, orgs);
    }

    function radialOrgItem(org, index, total, currentId) {
        const label = orgLabelFor(org);
        const suffix =
            org.accessMode === 'viewer' ? ' (view)' : Number(org.id) === Number(currentId) ? '' : '';
        const active = Number(org.id) === Number(currentId);
        const angle = total <= 1 ? -90 : -90 + (360 / total) * index;
        return (
            '<button type="button" class="map-org-radial-item' +
            (active ? ' map-org-radial-item--active' : '') +
            '" data-action="org:' +
            org.id +
            '" role="menuitemradio" aria-checked="' +
            (active ? 'true' : 'false') +
            '" style="--radial-angle:' +
            angle +
            'deg" title="' +
            escapeHtml(label + suffix) +
            '">' +
            '<span class="map-org-radial-item-orbit">' +
            '<span class="map-org-radial-item-stack">' +
            '<span class="map-org-radial-item-icon" aria-hidden="true">' +
            orgIconInnerHtml(org) +
            '</span>' +
            '<span class="map-org-radial-item-label">' +
            escapeHtml(label + suffix) +
            '</span>' +
            '</span>' +
            '</span>' +
            '</button>'
        );
    }

    function renderOrgCircleMenu() {
        const menu = orgMenuEl();
        if (!menu) return;
        const mod = window.orgSelectorModule;
        const orgs = mod && mod.getOrganizations ? mod.getOrganizations() : [];
        const currentId = mod && mod.getCurrentOrgId ? mod.getCurrentOrgId() : null;
        const currentOrg =
            orgs.find(function (o) {
                return Number(o.id) === Number(currentId);
            }) || null;
        if (orgs.length > ORG_RADIAL_MAX) {
            renderOrgListMenu(menu, orgs, currentId, currentOrg);
        } else {
            renderOrgRadialMenu(menu, orgs, currentId, currentOrg);
        }
    }

    function positionOrgMenu() {
        const menu = orgMenuEl();
        if (!menu) return;
        const mod = window.orgSelectorModule;
        const orgs = mod && mod.getOrganizations ? mod.getOrganizations() : [];
        if (orgs.length > ORG_RADIAL_MAX) positionCircleMenu(menu);
    }

    function focusOrgListSearch() {
        const mod = window.orgSelectorModule;
        const orgs = mod && mod.getOrganizations ? mod.getOrganizations() : [];
        if (orgs.length <= ORG_RADIAL_MAX) return;
        const menu = orgMenuEl();
        if (!menu) return;
        const search = menu.querySelector('.map-org-list-search');
        if (search) search.focus();
    }

    function renderAccountCircleMenu() {
        const menu = accountMenuEl();
        if (!menu) return;
        const admin = document.getElementById('adminPanelMenuItem');
        const showAdmin = admin && admin.style.display !== 'none';
        let html = '';
        if (window.CORE_PRODUCT !== true) {
            html += bubbleButton('Data Hub', bubbleMenuIcon('dataHub', '📚'), { action: 'data-hub' });
        }
        html += bubbleButton('Settings', bubbleMenuIcon('settings', '⚙'), { action: 'settings' });
        if (showAdmin) html += bubbleButton('Admin Panel', bubbleMenuIcon('adminPanel', '🛡'), { action: 'admin' });
        html += bubbleButton('Logout', '⎋', { action: 'logout', danger: true });
        menu.classList.add('map-account-toolbar-menu');
        menu.innerHTML =
            '<div class="map-circle-menu-bubbles" role="menu" aria-label="Account menu">' + html + '</div>';
        if (typeof window.applyAdminPanelMenuBadge === 'function') {
            window.applyAdminPanelMenuBadge();
        }
    }

    function positionAccountMenu() {
        const menu = accountMenuEl();
        const btn = document.getElementById('profileMenuButton');
        if (!menu || !btn) return;
        const rect = btn.getBoundingClientRect();
        const gap = 8;
        menu.style.top = Math.round(rect.top) + 'px';
        menu.style.right = Math.max(8, Math.round(window.innerWidth - rect.left + gap)) + 'px';
        menu.style.left = 'auto';
        menu.style.transform = 'none';
    }

    function openCircleMenu(kind) {
        if (typeof window.ensureMapHubOverlaysOnBody === 'function') {
            window.ensureMapHubOverlaysOnBody();
        }
        closeAllCircleMenus();
        if (kind !== 'org' && kind !== 'account') return;
        openMenuKind = kind;
        const backdrop = backdropEl();
        const menu = kind === 'org' ? orgMenuEl() : accountMenuEl();
        if (!menu || !backdrop) return;
        if (kind === 'org') {
            const mod = window.orgSelectorModule;
            const orgs = mod && mod.getOrganizations ? mod.getOrganizations() : [];
            const currentId = mod && mod.getCurrentOrgId ? mod.getCurrentOrgId() : null;
            if (orgs.length > ORG_RADIAL_MAX && currentId != null) {
                orgListPickerState.page = getOrgListPageForOrg(orgs, currentId, '');
            }
            if (
                window.feedMapLayerModule &&
                typeof window.feedMapLayerModule.refreshFeedOpenCount === 'function'
            ) {
                void window.feedMapLayerModule.refreshFeedOpenCount().then(function () {
                    // Re-render so badge reflects latest count after async fetch
                    if (openMenuKind === 'org') {
                        renderOrgCircleMenu();
                        positionOrgMenu();
                    }
                });
            }
            renderOrgCircleMenu();
            positionOrgMenu();
            requestAnimationFrame(focusOrgListSearch);
        } else {
            renderAccountCircleMenu();
            positionAccountMenu();
        }
        backdrop.classList.add('map-circle-menu-backdrop--visible');
        backdrop.setAttribute('aria-hidden', 'false');
        menu.classList.add('map-circle-menu--open');
        menu.setAttribute('aria-hidden', 'false');
        const btn = kind === 'org' ? document.getElementById('orgMenuButton') : document.getElementById('profileMenuButton');
        if (btn) btn.setAttribute('aria-expanded', 'true');
    }

    async function handleOrgPick(orgId) {
        closeAllCircleMenus();
        if (window.orgSelectorModule && typeof window.orgSelectorModule.switchOrganization === 'function') {
            await window.orgSelectorModule.switchOrganization(orgId);
        }
    }

    function handleAccountAction(action) {
        closeAllCircleMenus();
        switch (action) {
            case 'settings':
                if (typeof window.openSettings === 'function') window.openSettings();
                break;
            case 'admin':
                window.location.href = 'admin.html';
                break;
            case 'data-hub':
                if (typeof window.openDataWindow === 'function') window.openDataWindow();
                break;
            case 'logout':
                if (typeof window.signOut === 'function') window.signOut();
                break;
            default:
                break;
        }
    }

    function onOrgListSearchInput(e) {
        const input = e.target.closest('.map-org-list-search');
        if (!input || openMenuKind !== 'org') return;
        e.stopPropagation();
        orgListPickerState.query = input.value;
        orgListPickerState.page = 1;
        renderOrgCircleMenu();
        positionOrgMenu();
    }

    function onOrgListPaginationClick(e) {
        const btn = e.target.closest('[data-org-list-page]');
        if (!btn || btn.disabled || openMenuKind !== 'org') return;
        e.preventDefault();
        e.stopPropagation();
        const dir = btn.getAttribute('data-org-list-page');
        const mod = window.orgSelectorModule;
        const orgs = mod && mod.getOrganizations ? mod.getOrganizations() : [];
        const filtered = getFilteredSortedOrgs(orgs);
        const totalPages = Math.max(1, Math.ceil(filtered.length / ORG_LIST_PAGE_SIZE) || 1);
        let page = Math.max(1, Math.floor(Number(orgListPickerState.page) || 1));
        if (dir === 'prev' && page > 1) page -= 1;
        else if (dir === 'next' && page < totalPages) page += 1;
        orgListPickerState.page = page;
        renderOrgCircleMenu();
        positionOrgMenu();
    }

    function onMenuClick(e) {
        if (e.target.closest('[data-org-list-page]')) {
            onOrgListPaginationClick(e);
            return;
        }
        const bubble = e.target.closest('.map-circle-menu-bubble, .map-org-radial-item, .map-org-list-item');
        if (!bubble) return;
        const action = bubble.getAttribute('data-action');
        if (!action || action === 'noop') return;
        e.preventDefault();
        e.stopPropagation();
        if (action.indexOf('org:') === 0) {
            const id = parseInt(action.slice(4), 10);
            if (!isNaN(id)) void handleOrgPick(id);
            return;
        }
        handleAccountAction(action);
    }

    function initMapCircleMenus() {
        ensureMapHubOverlaysOnBody();
        const backdrop = backdropEl();
        const orgMenu = orgMenuEl();
        const accountMenu = accountMenuEl();
        if (orgMenu) {
            orgMenu.addEventListener('click', onMenuClick);
            orgMenu.addEventListener('input', onOrgListSearchInput);
        }
        if (accountMenu) accountMenu.addEventListener('click', onMenuClick);
        if (backdrop) {
            backdrop.addEventListener('click', closeAllCircleMenus);
        }
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && openMenuKind) closeAllCircleMenus();
        });
        window.addEventListener('resize', function () {
            if (openMenuKind === 'account') positionAccountMenu();
            else if (openMenuKind === 'org') positionOrgMenu();
        });
    }

    function openOrgCircleMenu() {
        return;
    }

    function openAccountMenu() {
        if (typeof window.closeMapTopLeftLauncher === 'function') window.closeMapTopLeftLauncher();
        openCircleMenu('account');
    }

    function closeAccountMenu() {
        closeAllCircleMenus();
    }

    function openAccountMenuToggle() {
        if (openMenuKind === 'account') closeAccountMenu();
        else openAccountMenu();
    }

    window.ensureMapHubOverlaysOnBody = ensureMapHubOverlaysOnBody;
    window.initMapCircleMenus = initMapCircleMenus;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureMapHubOverlaysOnBody);
    } else {
        ensureMapHubOverlaysOnBody();
    }
    window.openOrgCircleMenu = openOrgCircleMenu;
    window.openAccountMenu = openAccountMenu;
    window.closeAccountMenu = closeAccountMenu;
    window.openAccountMenuToggle = openAccountMenuToggle;
    window.renderOrgCircleMenu = renderOrgCircleMenu;
    window.renderOrgCircleMenuIfOpen = renderOrgCircleMenuIfOpen;
    window.renderAccountCircleMenu = renderAccountCircleMenu;
    window.closeAllCircleMenus = closeAllCircleMenus;
    window.handleAccountMenuAction = handleAccountAction;
})();
