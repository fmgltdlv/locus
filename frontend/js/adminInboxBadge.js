/**
 * Dev-only dual badges on ☰ and Admin Panel: red = general admin inbox, blue = service requests.
 */
(function () {
    var lastAdminBadgeCounts = { general: 0, serviceRequests: 0 };

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

    function buildOpenMenuAriaLabel(general, sr) {
        var parts = [];
        if (general > 0) {
            parts.push(general + ' admin item' + (general === 1 ? '' : 's'));
        }
        if (sr > 0) {
            parts.push(sr + ' service request' + (sr === 1 ? '' : 's'));
        }
        if (!parts.length) return 'Open menu';
        return 'Open menu — ' + parts.join(', ');
    }

    function buildAdminPanelAriaLabel(general, sr) {
        var parts = [];
        if (general > 0) {
            parts.push(general + ' admin item' + (general === 1 ? '' : 's'));
        }
        if (sr > 0) {
            parts.push(sr + ' service request' + (sr === 1 ? '' : 's'));
        }
        if (!parts.length) return 'Admin Panel';
        return 'Admin Panel — ' + parts.join(', ');
    }

    function parseInboxCounts(data) {
        if (!data || typeof data !== 'object') {
            return { general: 0, serviceRequests: 0 };
        }
        var sr = data.serviceRequestsNew != null ? Number(data.serviceRequestsNew) : 0;
        var err = Number(data.errorIncidents != null ? data.errorIncidents : 0) || 0;
        return {
            general: Number.isFinite(err) ? err : 0,
            serviceRequests: Number.isFinite(sr) ? sr : 0,
        };
    }

    function applyProfileMenuBadges(counts) {
        var generalBadge = document.getElementById('profileMenuButtonBadge');
        var srBadge = document.getElementById('profileMenuButtonSrBadge');
        var btn = document.getElementById('profileMenuButton');
        if (!btn) return;
        var general = counts && counts.general != null ? Number(counts.general) : 0;
        var sr = counts && counts.serviceRequests != null ? Number(counts.serviceRequests) : 0;
        setBadgeCount(generalBadge, general);
        setBadgeCount(srBadge, sr);
        btn.setAttribute('aria-label', buildOpenMenuAriaLabel(general, sr));
    }

    function removeLegacyAdminPanelBadge(btn) {
        btn.querySelectorAll('.admin-panel-menu-badge').forEach(function (el) {
            if (
                !el.classList.contains('admin-panel-menu-badge--general') &&
                !el.classList.contains('admin-panel-menu-badge--sr')
            ) {
                el.remove();
            }
        });
    }

    function ensureAdminPanelBadge(btn, kind) {
        var selector = '.admin-panel-menu-badge--' + kind;
        var badge = btn.querySelector(selector);
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'admin-panel-menu-badge admin-panel-menu-badge--' + kind;
            btn.appendChild(badge);
        }
        return badge;
    }

    function applyAdminPanelMenuBadges(counts) {
        var c = counts || lastAdminBadgeCounts;
        var general = c.general != null ? Number(c.general) : 0;
        var sr = c.serviceRequests != null ? Number(c.serviceRequests) : 0;
        var selectors = '[data-action="admin"], [data-launcher-action="admin"]';
        document.querySelectorAll(selectors).forEach(function (btn) {
            removeLegacyAdminPanelBadge(btn);
            setBadgeCount(ensureAdminPanelBadge(btn, 'general'), general);
            setBadgeCount(ensureAdminPanelBadge(btn, 'sr'), sr);
            btn.setAttribute('aria-label', buildAdminPanelAriaLabel(general, sr));
        });
    }

    function clearAllAdminBadges() {
        lastAdminBadgeCounts = { general: 0, serviceRequests: 0 };
        applyProfileMenuBadges(lastAdminBadgeCounts);
        applyAdminPanelMenuBadges(lastAdminBadgeCounts);
    }

    function refreshAdminInboxBadge() {
        if (!window.authModule || !window.authModule.isAuthenticated()) {
            clearAllAdminBadges();
            return;
        }
        if (!window.authModule.isDev || !window.authModule.isDev()) {
            clearAllAdminBadges();
            return;
        }
        window.authModule
            .apiRequest('admin/inbox-counts')
            .then(function (data) {
                lastAdminBadgeCounts = parseInboxCounts(data);
                applyProfileMenuBadges(lastAdminBadgeCounts);
                applyAdminPanelMenuBadges(lastAdminBadgeCounts);
            })
            .catch(function () {
                clearAllAdminBadges();
            });
    }

    /** @param {{ general?: number, serviceRequests?: number }|number|null} [counts] */
    function applyAdminPanelMenuBadge(counts) {
        if (counts != null && typeof counts === 'object') {
            lastAdminBadgeCounts = {
                general: counts.general != null ? Number(counts.general) : 0,
                serviceRequests: counts.serviceRequests != null ? Number(counts.serviceRequests) : 0,
            };
        }
        applyAdminPanelMenuBadges(lastAdminBadgeCounts);
    }

    document.addEventListener('DOMContentLoaded', function () {
        refreshAdminInboxBadge();
    });

    window.refreshAdminInboxBadge = refreshAdminInboxBadge;
    window.applyAdminPanelMenuBadge = applyAdminPanelMenuBadge;
    window.applyAdminPanelMenuBadges = applyAdminPanelMenuBadges;
})();
