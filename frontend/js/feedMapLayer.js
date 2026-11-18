/**
 * Documentation feed queue map layer (pins/polygons from GET /api/feed/map-markers).
 * Same zoom gate as tickets: pins below 16, polygons at zoom 16+.
 */
(function () {
    'use strict';

    const FEED_POLYGON_MIN_ZOOM = 16;
    let feedLayerGroup = null;
    let lastMarkers = [];
    let feedOpenCount = null;
    let feedOpenCountFetchedAt = 0;
    const FEED_OPEN_COUNT_TTL_MS = 60 * 1000;
    let feedZoomListenerAttached = false;
    /** @type {Array<{ polygon: object|null, marker: object|null, serviceRequestId: number|null }>} */
    let feedMapEntries = [];

    function getMap() {
        return typeof window.getMap === 'function' ? window.getMap() : window.map || null;
    }

    function apiBase() {
        return (window.authModule && window.authModule.API_BASE) || window.API_BASE || '';
    }

    function currentOrgId() {
        if (window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function') {
            return window.orgSelectorModule.getCurrentOrgId();
        }
        return typeof window.getCurrentOrgId === 'function' ? window.getCurrentOrgId() : null;
    }

    function isFeedWorkspace() {
        return !!(
            window.orgSelectorModule &&
            typeof window.orgSelectorModule.canUseCurrentDevTicketHub === 'function' &&
            window.orgSelectorModule.canUseCurrentDevTicketHub()
        );
    }

    function ensureLayer(map) {
        if (!map || typeof L === 'undefined') return null;
        if (!map.getPane('feedQueuePane')) {
            const pane = map.createPane('feedQueuePane');
            if (pane) pane.style.zIndex = 460;
        }
        if (!feedLayerGroup) {
            feedLayerGroup = L.layerGroup([], { pane: 'feedQueuePane' });
        }
        if (!map.hasLayer(feedLayerGroup)) {
            feedLayerGroup.addTo(map);
        }
        ensureFeedZoomListener(map);
        return feedLayerGroup;
    }

    function clearFeedMapLayer() {
        if (feedLayerGroup) {
            feedLayerGroup.clearLayers();
        }
        feedMapEntries = [];
        lastMarkers = [];
    }

    function colorForStatus(feedTicketStatus) {
        if (String(feedTicketStatus || '').toUpperCase() === 'READY') return '#22c55e';
        if (String(feedTicketStatus || '').toUpperCase() === 'NOT_READY') return '#f97316';
        return '#64748b';
    }

    function polygonToLatLngs(polygon) {
        if (!polygon || !polygon.coordinates) return null;
        try {
            if (polygon.type === 'Polygon') {
                const ring = polygon.coordinates[0] || [];
                return ring.map(function (c) {
                    return [c[1], c[0]];
                });
            }
            if (polygon.type === 'MultiPolygon') {
                const ring = (polygon.coordinates[0] && polygon.coordinates[0][0]) || [];
                return ring.map(function (c) {
                    return [c[1], c[0]];
                });
            }
        } catch (_e) {
            return null;
        }
        return null;
    }

    function pinLatLngFromMarker(m, latLngs) {
        if (m && m.pin && Number.isFinite(Number(m.pin.lat)) && Number.isFinite(Number(m.pin.lng))) {
            return L.latLng(Number(m.pin.lat), Number(m.pin.lng));
        }
        if (latLngs && latLngs.length) {
            try {
                return L.latLngBounds(latLngs).getCenter();
            } catch (_e) {
                /* ignore */
            }
        }
        return null;
    }

    function syncFeedMapZoomMode() {
        const map = getMap();
        const group = feedLayerGroup;
        if (!map || !group) return;
        const showPolygon = map.getZoom() >= FEED_POLYGON_MIN_ZOOM;
        feedMapEntries.forEach(function (entry) {
            if (!entry) return;
            if (entry.polygon && entry.marker) {
                if (showPolygon) {
                    if (group.hasLayer(entry.marker)) group.removeLayer(entry.marker);
                    if (!group.hasLayer(entry.polygon)) group.addLayer(entry.polygon);
                } else {
                    if (group.hasLayer(entry.polygon)) group.removeLayer(entry.polygon);
                    if (!group.hasLayer(entry.marker)) group.addLayer(entry.marker);
                }
            } else if (entry.polygon && !entry.marker) {
                if (!group.hasLayer(entry.polygon)) group.addLayer(entry.polygon);
            } else if (entry.marker && !entry.polygon) {
                if (!group.hasLayer(entry.marker)) group.addLayer(entry.marker);
            }
        });
    }

    function ensureFeedZoomListener(map) {
        if (!map || feedZoomListenerAttached) return;
        feedZoomListenerAttached = true;
        map.on('zoomend', function () {
            if (!isFeedWorkspace()) return;
            syncFeedMapZoomMode();
        });
    }

    function renderMarkers(markers) {
        const map = getMap();
        const group = ensureLayer(map);
        if (!group) return;
        group.clearLayers();
        feedMapEntries = [];
        lastMarkers = Array.isArray(markers) ? markers : [];
        const showPolygonNow = map && map.getZoom() >= FEED_POLYGON_MIN_ZOOM;

        lastMarkers.forEach(function (m) {
            const color = colorForStatus(m.feedTicketStatus);
            const latLngs = polygonToLatLngs(m.polygon);
            const popupHtml =
                '<div class="feed-queue-popup">' +
                '<strong>' +
                escapeHtml(m.organizationName || 'Org') +
                '</strong><br/>' +
                'Ticket ' +
                escapeHtml(m.ticketNumber || '—') +
                '<br/>' +
                escapeHtml(formatReady(m.feedTicketStatus)) +
                ' · ' +
                escapeHtml(formatSrStatus(m.serviceRequestStatus)) +
                '</div>';

            let polygonLayer = null;
            let markerLayer = null;

            if (latLngs && latLngs.length >= 3) {
                polygonLayer = L.polygon(latLngs, {
                    color: color,
                    weight: 2,
                    fillColor: color,
                    fillOpacity: 0.25,
                    pane: 'feedQueuePane',
                });
                polygonLayer.bindPopup(popupHtml);
                polygonLayer._feedServiceRequestId = m.serviceRequestId;
            }

            const pinLatLng = pinLatLngFromMarker(m, latLngs);
            if (pinLatLng) {
                markerLayer = L.circleMarker(pinLatLng, {
                    radius: 8,
                    color: color,
                    fillColor: color,
                    fillOpacity: 0.85,
                    weight: 2,
                    pane: 'feedQueuePane',
                });
                markerLayer.bindPopup(popupHtml);
                markerLayer._feedServiceRequestId = m.serviceRequestId;
            }

            if (!polygonLayer && !markerLayer) return;

            feedMapEntries.push({
                polygon: polygonLayer,
                marker: markerLayer,
                serviceRequestId: m.serviceRequestId != null ? Number(m.serviceRequestId) : null,
            });

            if (polygonLayer && markerLayer) {
                if (showPolygonNow) group.addLayer(polygonLayer);
                else group.addLayer(markerLayer);
            } else if (polygonLayer) {
                group.addLayer(polygonLayer);
            } else {
                group.addLayer(markerLayer);
            }
        });
    }

    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function formatReady(status) {
        const s = String(status || '').toUpperCase();
        if (s === 'READY') return 'Ready';
        if (s === 'NOT_READY') return 'Not ready';
        return '—';
    }

    function formatSrStatus(status) {
        const s = String(status || '').toLowerCase();
        if (s === 'complete') return 'Map covered';
        if (s === 'incomplete' || s === 'new') return 'Needs map';
        return s || '—';
    }

    function findDocumentationFeedOrgId() {
        const orgs =
            (window.orgSelectorModule &&
                typeof window.orgSelectorModule.getOrganizations === 'function' &&
                window.orgSelectorModule.getOrganizations()) ||
            (typeof window.getOrganizations === 'function' && window.getOrganizations()) ||
            [];
        const feedOrg = (orgs || []).find(function (o) {
            return o && o.isDevTicketHub;
        });
        return feedOrg && feedOrg.id != null ? Number(feedOrg.id) : null;
    }

    function syncFeedOpenCountBubble() {
        if (typeof window.syncMapTopLeftActiveStatBubble === 'function') {
            window.syncMapTopLeftActiveStatBubble();
        } else if (typeof window.renderHubStats === 'function') {
            window.renderHubStats();
        }
    }

    async function refreshFeedOpenCount(opts) {
        const options = opts || {};
        const force = options.force === true;
        if (
            !window.authModule ||
            typeof window.authModule.apiRequest !== 'function' ||
            typeof window.authModule.isDev !== 'function' ||
            !window.authModule.isDev()
        ) {
            feedOpenCount = null;
            feedOpenCountFetchedAt = 0;
            syncFeedOpenCountBubble();
            return null;
        }
        const feedOrgId = findDocumentationFeedOrgId();
        if (!feedOrgId) {
            feedOpenCount = null;
            feedOpenCountFetchedAt = 0;
            syncFeedOpenCountBubble();
            return null;
        }
        if (
            !force &&
            feedOpenCount != null &&
            feedOpenCountFetchedAt > 0 &&
            Date.now() - feedOpenCountFetchedAt < FEED_OPEN_COUNT_TTL_MS
        ) {
            syncFeedOpenCountBubble();
            return feedOpenCount;
        }
        try {
            const data = await window.authModule.apiRequest(
                apiBase() + '/feed/open-count?organizationId=' + encodeURIComponent(String(feedOrgId))
            );
            feedOpenCount = data && data.count != null ? Number(data.count) : 0;
            feedOpenCountFetchedAt = Date.now();
            if (typeof window.renderOrgCircleMenuIfOpen === 'function') {
                window.renderOrgCircleMenuIfOpen();
            } else if (typeof window.renderOrgCircleMenu === 'function') {
                window.renderOrgCircleMenu();
            }
            syncFeedOpenCountBubble();
            return feedOpenCount;
        } catch (e) {
            console.warn('refreshFeedOpenCount:', e);
            return null;
        }
    }

    async function loadFeedMapMarkers() {
        const map = getMap();
        if (!isFeedWorkspace()) {
            clearFeedMapLayer();
            feedOpenCount = null;
            syncFeedOpenCountBubble();
            return;
        }
        const orgId = currentOrgId();
        if (!orgId || !window.authModule || typeof window.authModule.apiRequest !== 'function') {
            clearFeedMapLayer();
            return;
        }
        ensureLayer(map);
        try {
            const data = await window.authModule.apiRequest(
                apiBase() + '/feed/map-markers?organizationId=' + encodeURIComponent(String(orgId))
            );
            renderMarkers((data && data.markers) || []);
            void refreshFeedOpenCount();
        } catch (e) {
            console.warn('loadFeedMapMarkers:', e);
            clearFeedMapLayer();
        }
    }

    function getFeedOpenCount() {
        return feedOpenCount;
    }

    function getLastFeedMarkers() {
        return lastMarkers.slice();
    }

    window.feedMapLayerModule = {
        loadFeedMapMarkers,
        clearFeedMapLayer,
        refreshFeedOpenCount,
        getFeedOpenCount,
        getLastFeedMarkers,
        isFeedWorkspace,
    };
    window.loadFeedMapMarkers = loadFeedMapMarkers;
    window.clearFeedMapLayer = clearFeedMapLayer;
    window.refreshFeedOpenCount = refreshFeedOpenCount;
})();
