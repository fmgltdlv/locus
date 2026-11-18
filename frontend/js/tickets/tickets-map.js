
// Render tickets on map
let isRenderingTickets = false; // Prevent multiple simultaneous renders
let ticketMapRenderGeneration = 0;
const ticketMapRenderedTicketIds = new Set();
let pendingAppendTickets = [];
let appendTicketsToMapTimer = null;
const APPEND_TICKETS_TO_MAP_DEBOUNCE_MS = 200;

function markTicketMapPolygonFadeIn(polygonLayer) {
    if (!polygonLayer) return;
    const apply = (layer) => {
        if (layer && layer._path && layer._path.classList) {
            layer._path.classList.remove('ticket-map-polygon--fade-in');
            // Force reflow so re-adding the class retriggers animation on updates.
            void layer._path.offsetWidth;
            layer._path.classList.add('ticket-map-polygon--fade-in');
        }
    };
    if (typeof polygonLayer.eachLayer === 'function') {
        polygonLayer.eachLayer(apply);
    } else {
        apply(polygonLayer);
    }
}

/**
 * Show or refresh one ticket's polygon on the map without a full renderTickets() teardown.
 * Used when polygon backfill returns geometry incrementally.
 */
function applyTicketPolygonBackfillToMap(ticket) {
    const map = window.map;
    if (!map || !ticket || !ticketHasDisplayablePolygon(ticket)) return;
    if (isRenderingTickets) return;

    if (!ticketLayerGroup) {
        renderTickets();
        return;
    }

    ensureTicketMarkerClusterGroup(map);
    ensureTicketStatusForMap(ticket);
    const showPolygonNow = map.getZoom() >= TICKET_POLYGON_MIN_ZOOM;
    const markerGroup = getTicketMarkerGroup();
    const fresh = buildTicketMapLayersForTicket(ticket, showPolygonNow);

    let entry = ticketMapEntries.find((e) => ticketIdEquals(e.ticketId, ticket.id));
    if (entry) {
        if (entry.marker) {
            if (markerGroup.hasLayer(entry.marker)) markerGroup.removeLayer(entry.marker);
            if (ticketLayerGroup.hasLayer(entry.marker)) ticketLayerGroup.removeLayer(entry.marker);
        }
        if (entry.polygon && ticketLayerGroup.hasLayer(entry.polygon)) {
            ticketLayerGroup.removeLayer(entry.polygon);
        }
        if (entry.loadingMarker && ticketLayerGroup.hasLayer(entry.loadingMarker)) {
            ticketLayerGroup.removeLayer(entry.loadingMarker);
        }
        entry.polygon = fresh.polygon;
        entry.marker = fresh.marker;
        entry.loadingMarker = fresh.loadingMarker;
        entry.popupContent = fresh.popupContent;
    } else {
        if (!shouldRenderTicketOnMapNow(ticket)) return;
        entry = fresh;
        ticketMapEntries.push(entry);
        const idKey = ticketMapIdKey(ticket);
        if (idKey) ticketMapRenderedTicketIds.add(idKey);
    }

    if (entry.polygon && showPolygonNow) {
        entry.polygon.addTo(ticketLayerGroup);
        requestAnimationFrame(() => markTicketMapPolygonFadeIn(entry.polygon));
        if (entry.loadingMarker) entry.loadingMarker.addTo(ticketLayerGroup);
    } else if (entry.marker) {
        entry.marker.addTo(markerGroup);
    }

    updateTicketsLayerControl();
    syncTicketLayerPointerInteraction();
    reapplyOverlapPickerHoverHighlightIfNeeded();
}

function ticketMapIdKey(ticket) {
    return ticket && ticket.id != null ? String(ticket.id) : '';
}

let overlappingTicketPickerPopup = null;
const OVERLAP_PICKER_HOLD_MS = 600;
const OVERLAP_PICKER_HOLD_MOVE_CANCEL_PX = 10;
let overlapPickerHoverTicketId = null;
/** @type {Set<string> | null} */
let overlapPickerTicketIds = null;
let overlapPickerHoldTimer = null;
let overlapPickerHoldButton = null;
let overlapPickerHoldTicketId = null;
let overlapPickerHoldStartX = 0;
let overlapPickerHoldStartY = 0;
let overlapPickerHoldPreviewActive = false;
let overlapPickerSuppressClickButton = null;

function isPointInLatLngRing(point, ring) {
    if (!point || !ring || ring.length < 3) return false;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const yi = ring[i].lat;
        const xi = ring[i].lng;
        const yj = ring[j].lat;
        const xj = ring[j].lng;
        const intersect =
            yi > point.lat !== yj > point.lat &&
            point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

/** Point-in-polygon for Leaflet layers (Polygon, MultiPolygon rings, nested groups). */
function isPointInLeafletPolygonLayerRobust(point, layer) {
    if (!layer || !point || typeof layer.getLatLngs !== 'function') return false;
    const latlngs = layer.getLatLngs();
    if (!latlngs || !latlngs.length) return false;
    const first = latlngs[0];
    if (first && typeof first.lat === 'number') {
        return isPointInLatLngRing(point, latlngs);
    }
    for (let i = 0; i < latlngs.length; i++) {
        const part = latlngs[i];
        if (!part || !part.length) continue;
        if (part[0] && typeof part[0].lat === 'number') {
            if (isPointInLatLngRing(point, part)) return true;
            continue;
        }
        for (let j = 0; j < part.length; j++) {
            const ring = part[j];
            if (ring && ring[0] && typeof ring[0].lat === 'number' && isPointInLatLngRing(point, ring)) {
                return true;
            }
        }
    }
    return false;
}

/** True when click lat/lng lies inside a ticket map polygon layer (GeoJSON group or single polygon). */
function isPointInTicketMapPolygonLayer(point, geoJsonLayer) {
    if (!point || !geoJsonLayer) return false;
    let hit = false;
    const visit = function (layer) {
        if (hit || !layer) return;
        if (typeof layer.eachLayer === 'function') {
            layer.eachLayer(visit);
            return;
        }
        if (typeof layer.getLatLngs === 'function' && isPointInLeafletPolygonLayerRobust(point, layer)) {
            hit = true;
        }
    };
    visit(geoJsonLayer);
    return hit;
}

function isPointInLngLatRing(point, ring) {
    if (!point || !ring || ring.length < 3) return false;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];
        const intersect =
            yi > point.lat !== yj > point.lat &&
            point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

function isPointInGeoJsonPolygonGeometry(point, geometry) {
    if (!point || !geometry || typeof geometry !== 'object') return false;
    if (geometry.type === 'Feature') {
        return isPointInGeoJsonPolygonGeometry(point, geometry.geometry);
    }
    if (geometry.type === 'FeatureCollection' && Array.isArray(geometry.features)) {
        return geometry.features.some((f) => isPointInGeoJsonPolygonGeometry(point, f));
    }
    const geom = geometry.type ? geometry : null;
    if (!geom && Array.isArray(geometry.coordinates)) {
        const ring = geometry.coordinates[0];
        return Array.isArray(ring) && isPointInLngLatRing(point, ring);
    }
    if (!geom) return false;
    if (geom.type === 'Polygon' && Array.isArray(geom.coordinates)) {
        const ring = geom.coordinates[0];
        return Array.isArray(ring) && isPointInLngLatRing(point, ring);
    }
    if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
        return geom.coordinates.some((poly) => {
            const ring = poly && poly[0];
            return Array.isArray(ring) && isPointInLngLatRing(point, ring);
        });
    }
    return false;
}

function lookupTicketForMapEntry(ticketId) {
    const idKey = ticketId != null ? String(ticketId) : '';
    if (!idKey) return null;
    const pools = [getMapTicketsForMapLayers(), window.ORG_TICKETS || []];
    for (let p = 0; p < pools.length; p++) {
        const list = pools[p];
        if (!Array.isArray(list)) continue;
        const found = list.find((t) => t && ticketIdEquals(t.id, ticketId));
        if (found) return found;
    }
    return null;
}

/** Resolve a map-clicked ticket from hub slices as well as ORG_TICKETS (expired browse is hub-only). */
function findTicketForMapSelection(ticketId) {
    const fromMap = lookupTicketForMapEntry(ticketId);
    if (fromMap) return fromMap;
    const hubPools = [
        window.HUB_COMBINED_TICKETS,
        window.HUB_EXPIRED_TICKETS,
        window.HUB_ACTIVE_TICKETS,
    ];
    for (let i = 0; i < hubPools.length; i++) {
        const list = hubPools[i];
        if (!Array.isArray(list)) continue;
        const found = list.find((t) => t && ticketIdEquals(t.id, ticketId));
        if (found) return found;
    }
    return (window.ORG_TICKETS || []).find((t) => ticketIdEquals(t.id, ticketId)) || null;
}

function isTicketHubWindowOpen() {
    const hubWin = document.getElementById('ticketHubWindow');
    return !!(hubWin && hubWin.classList.contains('show'));
}

function pointInTicketPolygonData(ticket, point) {
    if (!ticket || !point) return false;
    const entry = ticketMapEntries.find((e) => e && ticketIdEquals(e.ticketId, ticket.id));
    if (entry && entry.polygon && isPointInTicketMapPolygonLayer(point, entry.polygon)) {
        return true;
    }
    if (ticket.polygon && isPointInGeoJsonPolygonGeometry(point, ticket.polygon)) {
        return true;
    }
    if (!ticketHasDisplayablePolygon(ticket)) return false;
    try {
        const layer = L.geoJSON(ticket.polygon);
        return isPointInTicketMapPolygonLayer(point, layer);
    } catch (_) {
        return false;
    }
}

/** Rough bounds area for overlap sort (relative ordering only). */
function estimateTicketPolygonArea(ticket) {
    if (!ticket || !ticketHasDisplayablePolygon(ticket)) return Infinity;
    try {
        const layer = L.geoJSON(ticket.polygon);
        const b = layer.getBounds();
        if (!b || (typeof b.isValid === 'function' && !b.isValid())) return Infinity;
        const sw = b.getSouthWest();
        const ne = b.getNorthEast();
        const latMid = ((sw.lat + ne.lat) / 2) * (Math.PI / 180);
        const latM = Math.abs(ne.lat - sw.lat) * 111320;
        const lngM = Math.abs(ne.lng - sw.lng) * 111320 * Math.cos(latMid);
        return latM * lngM;
    } catch (_) {
        return Infinity;
    }
}

function compareTicketsForOverlapPick(a, b) {
    const aSel = ticketIdEquals(a.id, selectedTicketId) ? 0 : 1;
    const bSel = ticketIdEquals(b.id, selectedTicketId) ? 0 : 1;
    if (aSel !== bSel) return aSel - bSel;
    const areaDiff = estimateTicketPolygonArea(a) - estimateTicketPolygonArea(b);
    if (areaDiff !== 0) return areaDiff;
    return String(a.ticketNumber || '').localeCompare(String(b.ticketNumber || ''));
}

/** Tickets whose visible polygon contains the map click (zoom >= TICKET_POLYGON_MIN_ZOOM). */
function findTicketsAtMapLatLng(latlng) {
    const map = window.map;
    if (!map || !latlng || map.getZoom() < TICKET_POLYGON_MIN_ZOOM) return [];
    const hits = new Map();

    ticketMapEntries.forEach((entry) => {
        if (!entry || entry.ticketId == null) return;
        let contains = false;
        if (entry.polygon) {
            contains = isPointInTicketMapPolygonLayer(latlng, entry.polygon);
        }
        const ticket = lookupTicketForMapEntry(entry.ticketId);
        if (!contains && ticket) {
            contains = pointInTicketPolygonData(ticket, latlng);
        }
        if (!contains) return;
        if (ticket) hits.set(String(ticket.id), ticket);
    });

    if (hits.size === 0) {
        const candidates = getTicketsForMapViewport(getMapTicketsForMapLayers()) || [];
        candidates.forEach((ticket) => {
            if (!ticket || ticket.id == null) return;
            if (!pointInTicketPolygonData(ticket, latlng)) return;
            hits.set(String(ticket.id), ticket);
        });
    }

    return Array.from(hits.values()).sort(compareTicketsForOverlapPick);
}

function overlapPickerSupportsHover() {
    try {
        return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    } catch (_) {
        return true;
    }
}

function bringTicketMapEntryToFront(entry) {
    if (!entry) return;
    function lift(layer) {
        if (!layer) return;
        if (typeof layer.bringToFront === 'function') {
            try {
                layer.bringToFront();
            } catch (_) {
                /* ignore */
            }
        }
        if (typeof layer.eachLayer === 'function') {
            layer.eachLayer(function (sub) {
                if (sub && typeof sub.bringToFront === 'function') {
                    try {
                        sub.bringToFront();
                    } catch (_) {
                        /* ignore */
                    }
                }
            });
        }
    }
    lift(entry.polygon);
    lift(entry.marker);
}

function cancelOverlapPickerHoldTimer() {
    if (overlapPickerHoldTimer != null) {
        clearTimeout(overlapPickerHoldTimer);
        overlapPickerHoldTimer = null;
    }
    if (overlapPickerHoldButton) {
        overlapPickerHoldButton.classList.remove('is-hold-preview');
        overlapPickerHoldButton = null;
    }
    overlapPickerHoldTicketId = null;
    overlapPickerHoldPreviewActive = false;
}

function clearOverlapPickerHoverHighlight() {
    cancelOverlapPickerHoldTimer();
    if (overlapPickerHoverTicketId == null) return;
    overlapPickerHoverTicketId = null;
    syncTicketMapPolygonFillForZoom();
}

function applyOverlapPickerHoverHighlight(hoveredTicketId) {
    if (!isOverlappingTicketPickerOpen() || hoveredTicketId == null || hoveredTicketId === '') {
        clearOverlapPickerHoverHighlight();
        return;
    }
    if (!overlapPickerTicketIds || overlapPickerTicketIds.size === 0) return;

    overlapPickerHoverTicketId = hoveredTicketId;
    const zoom = getTicketMapCurrentZoom();

    ticketMapEntries.forEach((entry) => {
        if (!entry || !entry.polygon || entry.ticketId == null) return;
        const id = String(entry.ticketId);
        if (!overlapPickerTicketIds.has(id)) return;
        const ticket = findTicketForMapSelection(entry.ticketId);
        if (!ticket) return;
        const base = ticketMapPolygonStyleForTicket(ticket);
        const isHovered = ticketIdEquals(entry.ticketId, hoveredTicketId);
        if (isHovered) {
            applyStyleToTicketMapPolygonLayer(entry.polygon, {
                ...base,
                weight: 5,
                fillOpacity: ticketMapPolygonFillOpacityForZoom(
                    ticketIdEquals(ticket.id, selectedTicketId),
                    zoom,
                    true
                ),
            });
            bringTicketMapEntryToFront(entry);
        } else {
            const softened = ticketMapPolygonFillOpacityForZoom(false, zoom, true) * 0.5;
            applyStyleToTicketMapPolygonLayer(entry.polygon, {
                ...base,
                weight: 2,
                fillOpacity: softened,
            });
        }
    });
}

function reapplyOverlapPickerHoverHighlightIfNeeded() {
    if (overlapPickerHoverTicketId == null) return;
    if (!isOverlappingTicketPickerOpen()) return;
    applyOverlapPickerHoverHighlight(overlapPickerHoverTicketId);
}

function cleanupOverlapPickerInteractionOnly() {
    cancelOverlapPickerHoldTimer();
    overlapPickerHoverTicketId = null;
    overlapPickerTicketIds = null;
    overlapPickerSuppressClickButton = null;
}

function onOverlapPickerPopupRemoved() {
    overlappingTicketPickerPopup = null;
    cleanupOverlapPickerInteractionOnly();
    syncTicketMapPolygonFillForZoom();
    if (typeof renderTickets === 'function') {
        renderTickets();
    }
}

function closeOverlappingTicketPicker() {
    const map = window.map;
    const popup = overlappingTicketPickerPopup;
    if (!popup) {
        cleanupOverlapPickerInteractionOnly();
        return;
    }
    overlappingTicketPickerPopup = null;
    popup.off('remove', onOverlapPickerPopupRemoved);
    if (map && typeof map.hasLayer === 'function' && map.hasLayer(popup)) {
        map.closePopup(popup);
    }
    cleanupOverlapPickerInteractionOnly();
    syncTicketMapPolygonFillForZoom();
    if (typeof renderTickets === 'function') {
        renderTickets();
    }
}

function isOverlappingTicketPickerOpen() {
    const popup = overlappingTicketPickerPopup;
    if (!popup) return false;
    const map = window.map;
    if (map && typeof map.hasLayer === 'function' && !map.hasLayer(popup)) {
        overlappingTicketPickerPopup = null;
        cleanupOverlapPickerInteractionOnly();
        if (typeof renderTickets === 'function') {
            renderTickets();
        }
        return false;
    }
    return true;
}

/** CSS class for .ticket-card-status — matches ticket list / hub badges. */
function ticketWorkflowStatusBadgeClass(status) {
    switch (status) {
        case 'READY':
            return 'ready';
        case 'NOT_READY':
            return 'not-ready';
        case 'ACTION_REQUIRED':
            return 'action-required';
        case 'EXPIRED':
            return 'expired';
        case 'CANCELLED':
            return 'cancelled';
        case 'EXPIRING_SOON':
            return 'expiring-soon';
        default:
            return 'ready';
    }
}

function buildTicketOverlapPickStatusBadgeHtml(ticket) {
    const statusCode =
        window.ticketsModule && typeof window.ticketsModule.getTicketWorkflowStatusForMap === 'function'
            ? window.ticketsModule.getTicketWorkflowStatusForMap(ticket)
            : ticket.status;
    const statusLabel = escapeHtmlTicketUi(window.formatWorkflowStatusDisplay(statusCode));
    const statusClass = ticketWorkflowStatusBadgeClass(statusCode);
    const fallback =
        '<span class="ticket-card-status ' +
        statusClass +
        '">' +
        statusLabel +
        '</span>';
    const wm = window.workflowAckModule;
    if (wm && typeof wm.preferCoreStatusIndicatorHtml === 'function') {
        return wm.preferCoreStatusIndicatorHtml(statusCode, fallback);
    }
    return fallback;
}

function getTicketMapCurrentZoom() {
    const map = window.map;
    return map && typeof map.getZoom === 'function' ? map.getZoom() : 0;
}

function ticketMapPolygonFillOpacityForZoom(isSelected, zoom, highlightMode) {
    if (zoom >= TICKET_POLYGON_FILL_TRANSPARENT_MIN_ZOOM) return 0;
    if (highlightMode) return 0.3;
    return isSelected ? 0.4 : 0.2;
}

/** Polygon stroke (border) — expired: solid white; cancelled: dashed white. */
function ticketMapPolygonStrokeForStatus(status, defaultColor) {
    switch (status) {
        case 'EXPIRED':
            return { color: '#ffffff', dashArray: null };
        case 'CANCELLED':
            return { color: '#ffffff', dashArray: '8, 8' };
        default:
            return { color: defaultColor, dashArray: null };
    }
}

function ticketMapPolygonStyleForTicket(ticket) {
    const isSelected = ticketIdEquals(ticket.id, selectedTicketId);
    const status = getTicketWorkflowStatusForMap(ticket);
    const color = ticketStatusToMapColor(ticket);
    const stroke = ticketMapPolygonStrokeForStatus(status, color);
    return {
        className: 'ticket-map-polygon',
        color: stroke.color,
        dashArray: stroke.dashArray,
        weight: isSelected ? 4 : 2,
        fillColor: color,
        fillOpacity: ticketMapPolygonFillOpacityForZoom(isSelected, getTicketMapCurrentZoom(), false),
    };
}

function applyStyleToTicketMapPolygonLayer(polygonLayer, style) {
    if (!polygonLayer || !style) return;
    if (typeof polygonLayer.setStyle === 'function') {
        try {
            polygonLayer.setStyle(style);
        } catch (_) {
            /* ignore */
        }
    }
    if (typeof polygonLayer.eachLayer === 'function') {
        polygonLayer.eachLayer(function (sub) {
            if (typeof sub.setStyle === 'function') {
                try {
                    sub.setStyle(style);
                } catch (_) {
                    /* ignore */
                }
            }
        });
    }
}

function restoreTicketMapPolygonStyles() {
    const tickets = window.ORG_TICKETS || [];
    ticketMapEntries.forEach((entry) => {
        if (!entry || !entry.polygon || entry.ticketId == null) return;
        const ticket = tickets.find((t) => ticketIdEquals(t.id, entry.ticketId));
        if (!ticket) return;
        applyStyleToTicketMapPolygonLayer(entry.polygon, ticketMapPolygonStyleForTicket(ticket));
    });
}

function highlightTicketPolygonsForQueryMode() {
    const zoom = getTicketMapCurrentZoom();
    ticketMapEntries.forEach((entry) => {
        if (!entry || !entry.polygon) return;
        applyStyleToTicketMapPolygonLayer(entry.polygon, {
            weight: 4,
            fillOpacity: ticketMapPolygonFillOpacityForZoom(false, zoom, true),
        });
    });
}

function highlightComplianceHubProjectMapPickSelection(selectedIds) {
    const selected =
        selectedIds instanceof Set
            ? selectedIds
            : new Set((selectedIds || []).map((id) => String(id)));
    const zoom = getTicketMapCurrentZoom();
    ticketMapEntries.forEach((entry) => {
        if (!entry || !entry.polygon) return;
        const id = entry.ticketId != null ? String(entry.ticketId) : '';
        if (selected.has(id)) {
            applyStyleToTicketMapPolygonLayer(entry.polygon, {
                weight: 5,
                color: '#22c55e',
                fillColor: '#22c55e',
                fillOpacity: zoom < TICKET_POLYGON_FILL_TRANSPARENT_MIN_ZOOM ? 0.35 : 0,
            });
            return;
        }
        const ticket = findTicketForMapSelection(entry.ticketId);
        if (!ticket) return;
        const base = ticketMapPolygonStyleForTicket(ticket);
        applyStyleToTicketMapPolygonLayer(entry.polygon, {
            ...base,
            weight: 4,
            fillOpacity: ticketMapPolygonFillOpacityForZoom(false, zoom, true),
        });
    });
}

function syncTicketMapPolygonFillForZoom() {
    if (window.complianceHubProjectMapPickMode) {
        const pickFn = window.complianceHubProjectMapPickGetSelectedIds;
        if (typeof pickFn === 'function') {
            highlightComplianceHubProjectMapPickSelection(pickFn());
        } else {
            highlightTicketPolygonsForQueryMode();
        }
        reapplyOverlapPickerHoverHighlightIfNeeded();
        return;
    }
    if (window.queryByTicketMode) {
        highlightTicketPolygonsForQueryMode();
        reapplyOverlapPickerHoverHighlightIfNeeded();
        return;
    }
    restoreTicketMapPolygonStyles();
    reapplyOverlapPickerHoverHighlightIfNeeded();
}

function showOverlappingTicketPicker(latlng, tickets, onPick) {
    closeOverlappingTicketPicker();
    const map = window.map;
    if (!map || !tickets || tickets.length === 0 || typeof onPick !== 'function') return;

    const items = tickets
        .map((t) => {
            const tid = String(t.id);
            const num = escapeHtmlTicketUi(String(t.ticketNumber || t.id || ''));
            const statusBadge = buildTicketOverlapPickStatusBadgeHtml(t);
            const locRaw = t.locationSummary != null ? String(t.locationSummary).trim() : '';
            const loc = locRaw ? escapeHtmlTicketUi(locRaw.length > 72 ? locRaw.slice(0, 72) + '…' : locRaw) : '';
            return (
                '<button type="button" class="ticket-overlap-pick-btn" data-ticket-id="' +
                escapeHtmlTicketUi(tid) +
                '">' +
                '<span class="ticket-overlap-pick-top">' +
                '<span class="ticket-overlap-pick-num">' +
                num +
                '</span>' +
                statusBadge +
                '</span>' +
                (loc ? '<span class="ticket-overlap-pick-loc">' + loc + '</span>' : '') +
                '</button>'
            );
        })
        .join('');

    const title =
        tickets.length === 1
            ? '1 ticket here'
            : typeof window.t === 'function'
              ? window.t('{n} tickets here', { n: tickets.length })
              : tickets.length + ' tickets here';

    const html =
        '<div class="ticket-overlap-pick-list" role="listbox" aria-label="Select ticket">' +
        '<div class="ticket-overlap-pick-title">' +
        escapeHtmlTicketUi(title) +
        '</div>' +
        items +
        '</div>';

    overlappingTicketPickerPopup = L.popup({
        className: 'ticket-overlap-pick-popup',
        closeButton: true,
        maxWidth: 320,
        autoPan: true,
        closeOnClick: false,
        autoClose: false,
    })
        .setLatLng(latlng)
        .setContent(html)
        .openOn(map);

    overlappingTicketPickerPopup.on('remove', onOverlapPickerPopupRemoved);

    const el = overlappingTicketPickerPopup.getElement();
    if (el) {
        if (typeof L !== 'undefined' && L.DomEvent) {
            L.DomEvent.disableClickPropagation(el);
            L.DomEvent.disableScrollPropagation(el);
        }
        overlapPickerTicketIds = new Set(
            tickets.map((t) => (t && t.id != null ? String(t.id) : '')).filter(Boolean)
        );
        const useHoverPath = overlapPickerSupportsHover();
        const listEl = el.querySelector('.ticket-overlap-pick-list');

        el.querySelectorAll('.ticket-overlap-pick-btn').forEach((btn) => {
            const tid = btn.getAttribute('data-ticket-id');

            btn.addEventListener('click', function (ev) {
                if (overlapPickerSuppressClickButton === btn) {
                    overlapPickerSuppressClickButton = null;
                    if (typeof L !== 'undefined' && L.DomEvent) {
                        L.DomEvent.stopPropagation(ev);
                    }
                    ev.preventDefault();
                    return;
                }
                if (typeof L !== 'undefined' && L.DomEvent) {
                    L.DomEvent.stopPropagation(ev);
                }
                closeOverlappingTicketPicker();
                if (tid != null && tid !== '') onPick(tid);
            });

            if (useHoverPath) {
                btn.addEventListener('pointerenter', function () {
                    applyOverlapPickerHoverHighlight(tid);
                });
                btn.addEventListener('focusin', function () {
                    applyOverlapPickerHoverHighlight(tid);
                });
            } else {
                btn.addEventListener('pointerdown', function (ev) {
                    if (ev.button != null && ev.button !== 0) return;
                    overlapPickerSuppressClickButton = null;
                    cancelOverlapPickerHoldTimer();
                    overlapPickerHoldButton = btn;
                    overlapPickerHoldTicketId = tid;
                    overlapPickerHoldStartX = ev.clientX;
                    overlapPickerHoldStartY = ev.clientY;
                    overlapPickerHoldPreviewActive = false;
                    overlapPickerHoldTimer = setTimeout(function () {
                        overlapPickerHoldTimer = null;
                        if (!overlapPickerHoldTicketId || overlapPickerHoldButton !== btn) return;
                        overlapPickerHoldPreviewActive = true;
                        btn.classList.add('is-hold-preview');
                        applyOverlapPickerHoverHighlight(overlapPickerHoldTicketId);
                    }, OVERLAP_PICKER_HOLD_MS);
                });
                btn.addEventListener(
                    'pointermove',
                    function (ev) {
                        if (overlapPickerHoldButton !== btn) return;
                        const dx = ev.clientX - overlapPickerHoldStartX;
                        const dy = ev.clientY - overlapPickerHoldStartY;
                        if (dx * dx + dy * dy > OVERLAP_PICKER_HOLD_MOVE_CANCEL_PX * OVERLAP_PICKER_HOLD_MOVE_CANCEL_PX) {
                            const hadPreview = overlapPickerHoldPreviewActive;
                            cancelOverlapPickerHoldTimer();
                            if (hadPreview || overlapPickerHoverTicketId != null) {
                                overlapPickerHoverTicketId = null;
                                syncTicketMapPolygonFillForZoom();
                            }
                        }
                    },
                    { passive: true }
                );
                function onHoldPointerEnd() {
                    if (overlapPickerHoldButton !== btn) return;
                    const hadPreview = overlapPickerHoldPreviewActive;
                    cancelOverlapPickerHoldTimer();
                    if (hadPreview) {
                        overlapPickerHoverTicketId = null;
                        syncTicketMapPolygonFillForZoom();
                        overlapPickerSuppressClickButton = btn;
                    }
                }
                btn.addEventListener('pointerup', onHoldPointerEnd);
                btn.addEventListener('pointercancel', onHoldPointerEnd);
            }
        });

        if (useHoverPath && listEl) {
            listEl.addEventListener('pointerleave', function () {
                clearOverlapPickerHoverHighlight();
            });
            listEl.addEventListener('focusout', function (ev) {
                const next = ev.relatedTarget;
                if (!next || !listEl.contains(next)) {
                    clearOverlapPickerHoverHighlight();
                }
            });
        }
    }
}

function resolveTicketMapPick(ticketId) {
    if (window.complianceHubProjectMapPickMode && typeof window.complianceHubProjectMapPickToggleTicket === 'function') {
        const ticket = findTicketForMapSelection(ticketId);
        if (ticket) window.complianceHubProjectMapPickToggleTicket(ticket);
        return;
    }
    if (window.photoTicketAssociationPickMode && typeof window.photoTicketAssociationOnPick === 'function') {
        const ticket = findTicketForMapSelection(ticketId);
        if (ticket) window.photoTicketAssociationOnPick(ticket);
        return;
    }
    if (window.queryByTicketMode && typeof window.queryByTicketOnPick === 'function') {
        const ticket = findTicketForMapSelection(ticketId);
        if (ticket) window.queryByTicketOnPick(ticket);
        return;
    }
    selectTicket(ticketId);
}

/** Shared polygon/marker click: hit-test all overlapping tickets and show picker when needed. */
function handleTicketMapShapeClick(e, clickedTicket) {
    if (onTicketShapeClickWhileToolActive(e)) return;

    const latlng = e && e.latlng ? e.latlng : null;
    if (latlng && typeof window.findNearestMapFeatureLayer === 'function') {
        const tol =
            typeof window.ANNOTATION_PROXIMITY_TOLERANCE_PX === 'number'
                ? window.ANNOTATION_PROXIMITY_TOLERANCE_PX
                : 12;
        const featureLayer = window.findNearestMapFeatureLayer(window.map, latlng, tol);
        if (featureLayer && typeof featureLayer.openPopup === 'function') {
            if (typeof L !== 'undefined' && L.DomEvent) {
                L.DomEvent.stopPropagation(e);
            }
            featureLayer.openPopup(latlng);
            return;
        }
    }

    if (typeof L !== 'undefined' && L.DomEvent) {
        L.DomEvent.stopPropagation(e);
    }
    if (e && e.target && typeof e.target.closePopup === 'function') {
        e.target.closePopup();
    }
    if (window.map && typeof window.map.closePopup === 'function') {
        window.map.closePopup();
    }
    closeOverlappingTicketPicker();

    if (!latlng) {
        if (clickedTicket && clickedTicket.id != null) resolveTicketMapPick(clickedTicket.id);
        return;
    }

    let hits = findTicketsAtMapLatLng(latlng);
    if (
        clickedTicket &&
        clickedTicket.id != null &&
        !hits.some((t) => ticketIdEquals(t.id, clickedTicket.id))
    ) {
        hits = hits.concat([clickedTicket]);
        hits.sort(compareTicketsForOverlapPick);
    }
    if (hits.length === 0) {
        if (clickedTicket && clickedTicket.id != null) resolveTicketMapPick(clickedTicket.id);
        return;
    }
    if (hits.length === 1) {
        resolveTicketMapPick(hits[0].id);
        return;
    }

    showOverlappingTicketPicker(latlng, hits, function (ticketId) {
        resolveTicketMapPick(ticketId);
    });
}

function getTicketsForMapViewport(mapTickets) {
    const map = window.map;
    if (!map || map.getZoom() < TICKET_POLYGON_MIN_ZOOM) {
        return mapTickets;
    }
    const bounds = map.getBounds();
    if (!bounds || (typeof bounds.isValid === 'function' && !bounds.isValid())) {
        return mapTickets;
    }
    return (mapTickets || []).filter((ticket) => ticketIntersectsMapBounds(ticket, bounds));
}

function shouldRenderTicketOnMapNow(ticket) {
    const map = window.map;
    if (!map || map.getZoom() < TICKET_POLYGON_MIN_ZOOM) {
        return true;
    }
    const bounds = map.getBounds();
    if (!bounds || (typeof bounds.isValid === 'function' && !bounds.isValid())) {
        return true;
    }
    return ticketIntersectsMapBounds(ticket, bounds);
}

function isPublicCatalogMapTicket(ticket) {
    if (!ticket) return false;
    if (typeof window.isCurrentOrgPublicCatalogViewer !== 'function' || !window.isCurrentOrgPublicCatalogViewer()) {
        return false;
    }
    if (ticket.readOnly && ticket.shared) return true;
    const publicTickets = window.PUBLIC_MAP_TICKETS || [];
    return publicTickets.some((t) => ticketIdEquals(t.id, ticket.id));
}

function getPublicCatalogTicketOrgLabel(ticket) {
    if (typeof window.getTicketOrganizationDisplayName === 'function') {
        const fromHelper = window.getTicketOrganizationDisplayName(ticket);
        if (fromHelper != null && String(fromHelper).trim() !== '' && String(fromHelper).trim() !== '\u2014') {
            return String(fromHelper).trim();
        }
    }
    if (ticket && ticket.shared) {
        const label = ticket.sharedSourceLabel != null ? String(ticket.sharedSourceLabel).trim() : '';
        return label || 'Partner organization';
    }
    return '';
}

function buildPublicCatalogTicketMapPopupHtml(ticket, latLng) {
    const mod = window.ticketImporterModule;
    const parseParts =
        mod && typeof mod.parseTicketNumberParts === 'function'
            ? mod.parseTicketNumberParts
            : function (t) {
                  const raw = String((t && t.ticketNumber) || '').trim();
                  const idx = raw.indexOf('-');
                  if (idx === -1) return { baseNumber: raw, revisionSuffix: null };
                  return { baseNumber: raw.slice(0, idx), revisionSuffix: raw.slice(idx + 1) || null };
              };
    const numParts = parseParts(ticket);
    const revLabel =
        mod && typeof mod.resolveRevisionLabelForTicket === 'function'
            ? mod.resolveRevisionLabelForTicket(ticket)
            : numParts.revisionSuffix;
    const base = String(numParts.baseNumber || ticket.ticketNumber || '').trim();
    const rev =
        revLabel != null && String(revLabel).trim() !== '' ? String(revLabel).trim() : '\u2014';
    const orgLabel = getPublicCatalogTicketOrgLabel(ticket);
    const orgRow = orgLabel
        ? `<div class="map-leaflet-popup__meta">Organization: <strong>${escapeHtmlTicketUi(orgLabel)}</strong></div>`
        : '';
    const buildMapPopupGpsRow = typeof window.buildMapPopupGpsRow === 'function' ? window.buildMapPopupGpsRow : function () { return ''; };
    const gpsRow = latLng ? buildMapPopupGpsRow(latLng.lat, latLng.lng) : '';
    return `
            <div class="map-leaflet-popup">
                <div class="map-leaflet-popup__meta">Ticket number: <strong>${escapeHtmlTicketUi(base)}</strong></div>
                <div class="map-leaflet-popup__meta">Revision: <strong>${escapeHtmlTicketUi(rev)}</strong></div>
                ${orgRow}
                ${gpsRow}
            </div>
        `;
}

function onPublicCatalogTicketShapeClick(e) {
    if (onTicketShapeClickWhileToolActive(e)) return;
    if (typeof L !== 'undefined' && L.DomEvent) {
        L.DomEvent.stopPropagation(e);
    }
    if (typeof this.openPopup === 'function') {
        this.openPopup();
    }
}

function buildTicket811MarkerIconHtml(ticket, borderStyle) {
    const status =
        window.ticketsModule && typeof window.ticketsModule.getTicketWorkflowStatusForMap === 'function'
            ? window.ticketsModule.getTicketWorkflowStatusForMap(ticket)
            : ticket && ticket.status;
    if (window.mapIcons && typeof window.mapIcons.buildTicketMapPinMarkerHtml === 'function') {
        return window.mapIcons.buildTicketMapPinMarkerHtml(status, 18, borderStyle);
    }
    const color = ticketStatusToMapColor(ticket);
    return (
        '<div class="ticket-811-marker-icon" style="color:' +
        color +
        ';border:' +
        borderStyle +
        ';"></div>'
    );
}

function buildTicketMapLayersForTicket(ticket, showPolygonNow) {
    const isSelected = ticketIdEquals(ticket.id, selectedTicketId);
    const color = ticketStatusToMapColor(ticket);
    const bubbleBorder = isSelected ? '2px solid var(--app-text-inverse)' : '1.5px solid rgba(0,0,0,0.25)';
    const hasPoly = ticketHasDisplayablePolygon(ticket);

    let polygon = null;
    if (hasPoly) {
        polygon = L.geoJSON(ticket.polygon, {
            pane: 'ticketPane',
            style: ticketMapPolygonStyleForTicket(ticket),
            onEachFeature: function (feature, layer) {
                if (!feature.properties || typeof feature.properties !== 'object') {
                    feature.properties = {};
                }
                feature.properties.ticketId = ticket.id;
                if (layer && layer.feature) {
                    if (!layer.feature.properties) layer.feature.properties = {};
                    layer.feature.properties.ticketId = ticket.id;
                }
            },
        });
    }

    const isPublicCatalogTicket = isPublicCatalogMapTicket(ticket);
    const firstLatLng = hasPoly ? getFirstPolygonRingFirstLatLng(ticket.polygon) : null;
    const stubPin =
        ticket.stubMapPin &&
        Number.isFinite(Number(ticket.stubMapPin.lat)) &&
        Number.isFinite(Number(ticket.stubMapPin.lng))
            ? L.latLng(Number(ticket.stubMapPin.lat), Number(ticket.stubMapPin.lng))
            : null;
    const markerLatLng = firstLatLng || stubPin || ticketMapAnchorLatLng(ticket);

    const popupContent = isPublicCatalogTicket
        ? buildPublicCatalogTicketMapPopupHtml(ticket, markerLatLng)
        : `
            <div class="map-leaflet-popup">
                <div class="map-leaflet-popup__title">${escapeHtmlTicketUi(ticket.ticketNumber)}</div>
                <div class="map-leaflet-popup__meta">${escapeHtmlTicketUi(ticket.locationSummary || ticket.address || '')}</div>
                <span class="map-leaflet-popup__status" style="background: ${color};">
                    ${escapeHtmlTicketUi(
                        window.formatWorkflowStatusDisplay(
                            window.ticketsModule && typeof window.ticketsModule.getTicketWorkflowStatusForMap === 'function'
                                ? window.ticketsModule.getTicketWorkflowStatusForMap(ticket)
                                : ticket.status
                        )
                    )}
                </span>
            </div>
        `;
    const onTicketShapeClick = isPublicCatalogTicket
        ? onPublicCatalogTicketShapeClick
        : function (e) {
              handleTicketMapShapeClick(e, ticket);
          };

    if (polygon) {
        polygon.on('click', onTicketShapeClick);
        if (isPublicCatalogTicket) {
            polygon.bindPopup(popupContent);
        }
    }

    let marker = null;
    if (markerLatLng) {
        const polygonLoading = !hasPoly && ticketPolygonBackfillLoading(ticket);
        const selectionRefreshLoading = ticketSelectionRefreshLoading(ticket);
        const markerHasSubbadge = polygonLoading || selectionRefreshLoading;
        const markerHtml =
            '<div class="ticket-811-marker-content">' +
            buildTicket811MarkerIconHtml(ticket, bubbleBorder) +
            (polygonLoading
                ? '<span class="ticket-811-polygon-loading" title="Loading ticket boundary" aria-label="Loading ticket boundary"></span>'
                : selectionRefreshLoading
                  ? '<span class="ticket-list-sync-spinner" title="Loading ticket" aria-label="Loading ticket"></span>'
                  : '') +
            '</div>';
        marker = L.marker(markerLatLng, {
            pane: 'ticketPane',
            zIndexOffset: 600,
            icon: L.divIcon({
                className: 'ticket-811-marker-wrap' + (markerHasSubbadge ? ' ticket-811-marker-wrap--loading' : ''),
                html: markerHtml,
                iconSize: markerHasSubbadge ? [52, 30] : [30, 30],
                iconAnchor: markerHasSubbadge ? [15, 15] : [15, 15],
            }),
        });
        marker.on('click', onTicketShapeClick);
        if (isPublicCatalogTicket) {
            marker.bindPopup(popupContent);
        }
    }

    const loadingMarker =
        hasPoly && showPolygonNow && ticketSelectionRefreshLoading(ticket)
            ? buildTicketPolygonRefreshLoadingMarker(ticket)
            : null;

    return {
        ticketId: ticket.id,
        polygon,
        marker,
        loadingMarker,
        popupContent,
        isPublicCatalogTicket,
    };
}

function buildTicketPolygonRefreshLoadingMarker(ticket) {
    if (!ticket || !ticketHasDisplayablePolygon(ticket)) return null;
    const polyCenter = getFirstPolygonRingFirstLatLng(ticket.polygon);
    if (!polyCenter) return null;
    const spinHtml =
        '<div class="ticket-811-marker-content ticket-811-marker-content--poly-refresh">' +
        '<span class="ticket-list-sync-spinner" title="Refreshing ticket" aria-label="Refreshing ticket"></span>' +
        '</div>';
    return L.marker(polyCenter, {
        pane: 'ticketPane',
        zIndexOffset: 650,
        icon: L.divIcon({
            className: 'ticket-811-marker-wrap ticket-811-marker-wrap--loading',
            html: spinHtml,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
        }),
    });
}

/** Update polygon refresh spinner without clearing the whole ticket layer group. */
function syncTicketMapEntryRefreshLoading(ticketNumber) {
    const tn = ticketNumber != null ? String(ticketNumber).trim() : '';
    const map = window.map;
    if (!tn || !map || !ticketLayerGroup) return;
    const showPolygonNow = map.getZoom() >= TICKET_POLYGON_MIN_ZOOM;
    for (let i = 0; i < ticketMapEntries.length; i++) {
        const entry = ticketMapEntries[i];
        if (!entry || entry.ticketId == null) continue;
        const ticket = findTicketForMapSelection(entry.ticketId);
        if (!ticket || String(ticket.ticketNumber || '').trim() !== tn) continue;
        const busy = ticketSelectionRefreshLoading(ticket);
        const existing = entry.loadingMarker;
        if (busy && showPolygonNow) {
            if (!existing) {
                const marker = buildTicketPolygonRefreshLoadingMarker(ticket);
                if (marker) {
                    entry.loadingMarker = marker;
                    ticketLayerGroup.addLayer(marker);
                }
            }
        } else if (existing) {
            if (ticketLayerGroup.hasLayer(existing)) {
                ticketLayerGroup.removeLayer(existing);
            }
            entry.loadingMarker = null;
        }
        break;
    }
}

function canRefreshTicketMapSelectionWithoutRerender() {
    return ticketLayerGroup && ticketMapEntries.length > 0 && !isRenderingTickets;
}

/** Selected-ticket highlight without `renderTickets()` layer teardown (avoids popup open flicker). */
function refreshTicketMapSelectionVisuals() {
    if (typeof syncTicketMapZoomMode === 'function') {
        syncTicketMapZoomMode();
    }
    if (typeof syncTicketMapPolygonFillForZoom === 'function') {
        syncTicketMapPolygonFillForZoom();
    } else if (typeof restoreTicketMapPolygonStyles === 'function') {
        restoreTicketMapPolygonStyles();
    }
}

function applyTicketMapSelectionUiUpdate() {
    if (canRefreshTicketMapSelectionWithoutRerender()) {
        refreshTicketMapSelectionVisuals();
    } else {
        renderTickets();
    }
    renderTicketList();
}

function addTicketMapEntryToLayerGroups(entry, showPolygonNow) {
    const markerGroup = getTicketMarkerGroup();
    const { polygon, marker, loadingMarker } = entry;
    if (polygon && marker) {
        if (showPolygonNow) {
            polygon.addTo(ticketLayerGroup);
            if (loadingMarker) loadingMarker.addTo(ticketLayerGroup);
        } else {
            marker.addTo(markerGroup);
        }
    } else if (polygon) {
        polygon.addTo(ticketLayerGroup);
        if (showPolygonNow && loadingMarker) {
            loadingMarker.addTo(ticketLayerGroup);
        }
    } else if (marker) {
        marker.addTo(markerGroup);
    }
}

function appendTicketsToMap(tickets) {
    const map = window.map;
    if (!map || !tickets || tickets.length === 0 || isRenderingTickets) return;
    if (!ticketLayerGroup) {
        renderTickets();
        return;
    }
    ensureTicketMarkerClusterGroup(map);
    const showPolygonNow = map.getZoom() >= TICKET_POLYGON_MIN_ZOOM;
    tickets.forEach((ticket) => {
        if (!ticket) return;
        const idKey = ticketMapIdKey(ticket);
        if (!idKey || ticketMapRenderedTicketIds.has(idKey)) return;
        if (!shouldRenderTicketOnMapNow(ticket)) return;
        ensureTicketStatusForMap(ticket);
        const entry = buildTicketMapLayersForTicket(ticket, showPolygonNow);
        if (!entry.polygon && !entry.marker) return;
        addTicketMapEntryToLayerGroups(entry, showPolygonNow);
        ticketMapEntries.push(entry);
        ticketMapRenderedTicketIds.add(idKey);
    });
    updateTicketsLayerControl();
    syncTicketLayerPointerInteraction();
}

function scheduleAppendTicketsToMap(tickets) {
    if (!tickets || tickets.length === 0) return;
    pendingAppendTickets.push(...tickets);
    if (appendTicketsToMapTimer) clearTimeout(appendTicketsToMapTimer);
    appendTicketsToMapTimer = setTimeout(() => {
        appendTicketsToMapTimer = null;
        const batch = pendingAppendTickets.slice();
        pendingAppendTickets = [];
        appendTicketsToMap(batch);
    }, APPEND_TICKETS_TO_MAP_DEBOUNCE_MS);
}

function renderTickets(options) {
    const force = !!(options && options.force);
    const map = window.map;
    if (!map || typeof map.on !== 'function' || typeof map.getPane !== 'function') {
        return;
    }
    
    // Prevent multiple simultaneous renders (public search may force a fresh render after clear)
    if (isRenderingTickets && !force) {
        return;
    }
    const renderGen = force ? ticketMapRenderGeneration + 1 : ticketMapRenderGeneration;
    if (force) {
        ticketMapRenderGeneration = renderGen;
    }
    isRenderingTickets = true;
    ensureTicketPopupMapBackgroundDismiss();

    // Initialize ticket layer group if it doesn't exist
    if (!ticketLayerGroup) {
        // Custom pane for tickets — must be above aerial imagery (aerialMapPane 350) so polygon outlines stay visible.
        // Order: Base (tile ~200) < Aerial (350) < Tickets (380) < overlay-pane annotations (400) < marker panes.
        if (!map.getPane('ticketPane')) {
            map.createPane('ticketPane');
        }
        const ticketPaneEl = map.getPane('ticketPane');
        if (ticketPaneEl) ticketPaneEl.style.zIndex = '380';
        
        ticketLayerGroup = L.layerGroup();
        ticketLayerGroup.addTo(map);
        ensureTicketMapZoomListener();
        // Update layer control to include tickets
        updateTicketsLayerControl();
    }
    ensureTicketMarkerClusterGroup(map);
    
    // Clear existing ticket layers from the group (keep overlap picker open while user chooses)
    if (!isOverlappingTicketPickerOpen()) {
        closeOverlappingTicketPicker();
    }
    ticketLayerGroup.clearLayers();
    if (ticketMarkerClusterGroup) ticketMarkerClusterGroup.clearLayers();
    ticketMapEntries = [];
    ticketMapRenderedTicketIds.clear();
    pendingAppendTickets = [];
    if (appendTicketsToMapTimer) {
        clearTimeout(appendTicketsToMapTimer);
        appendTicketsToMapTimer = null;
    }

    // Get all tickets and filter based on status filter
    const mapTickets = getTicketsForMapViewport(getMapTicketsForMapLayers());

    if (mapTickets.length === 0) {
        updateTicketsLayerControl(); // Update layer control even if no tickets
        if (renderGen === ticketMapRenderGeneration) {
            isRenderingTickets = false;
        }
        return; // Don't try to render if no tickets match filter
    }
    const showPolygonNow = map.getZoom() >= TICKET_POLYGON_MIN_ZOOM;

    mapTickets.forEach((ticket) => {
        if (renderGen !== ticketMapRenderGeneration) return;
        const entry = buildTicketMapLayersForTicket(ticket, showPolygonNow);
        if (!entry.polygon && !entry.marker) return;
        addTicketMapEntryToLayerGroups(entry, showPolygonNow);
        ticketMapEntries.push(entry);
        const idKey = ticketMapIdKey(ticket);
        if (idKey) ticketMapRenderedTicketIds.add(idKey);
    });
    
    if (renderGen !== ticketMapRenderGeneration) {
        return;
    }

    // Update layer control
    updateTicketsLayerControl();

    syncTicketLayerPointerInteraction();

    if (isOverlappingTicketPickerOpen() && overlapPickerHoverTicketId != null) {
        const hoverId = overlapPickerHoverTicketId;
        requestAnimationFrame(function () {
            if (isOverlappingTicketPickerOpen() && ticketIdEquals(overlapPickerHoverTicketId, hoverId)) {
                applyOverlapPickerHoverHighlight(hoverId);
            }
        });
    }

    // Reset rendering flag
    isRenderingTickets = false;
    
    // Auto-zoom to show only active tickets (only on initial load, not when re-rendering)
    const autoZoomTickets = getMapTicketsForMapLayers();
    const bootHeld =
        window.pwaBootOverlay &&
        typeof window.pwaBootOverlay.isAppDataBootHeld === 'function' &&
        window.pwaBootOverlay.isAppDataBootHeld();
    if (shouldAutoZoomToAllTickets && !bootHeld && autoZoomTickets && autoZoomTickets.length > 0 && map) {
        // Use a longer delay to ensure map is fully ready
        setTimeout(function() {
            try {
                // Only auto-zoom if we haven't selected a ticket yet
                if (!selectedTicketId) {
                    const bounds = L.latLngBounds([]);
                    // Filter to only active tickets (not expired) for auto-zoom
                    const activeTickets = autoZoomTickets.filter(ticket => {
                        if (window.ticketsModule && typeof window.ticketsModule.isInactiveWorkflowStatus === 'function') {
                            return !window.ticketsModule.isInactiveWorkflowStatus(ticket.status);
                        }
                        return ticket.status !== 'EXPIRED' && ticket.status !== 'CANCELLED';
                    });
                    activeTickets.forEach(ticket => {
                        if (ticket && ticket.polygon) {
                            const layer = L.geoJSON(ticket.polygon);
                            const layerBounds = layer.getBounds();
                            if (layerBounds && layerBounds.isValid()) {
                                bounds.extend(layerBounds);
                            }
                        } else if (
                            ticket &&
                            ticket.stubMapPin &&
                            Number.isFinite(Number(ticket.stubMapPin.lat)) &&
                            Number.isFinite(Number(ticket.stubMapPin.lng))
                        ) {
                            bounds.extend([Number(ticket.stubMapPin.lat), Number(ticket.stubMapPin.lng)]);
                        }
                    });
                    if (bounds.isValid()) {
                        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
                    }
                }
            } catch (error) {
                console.error('Error auto-zooming to tickets:', error);
            }
            shouldAutoZoomToAllTickets = false; // Only auto-zoom once
        }, 800);
    }
}

// Select a ticket
function selectTicket(ticketId) {
    if (typeof window.isCurrentOrgPublicCatalogViewer === 'function' && window.isCurrentOrgPublicCatalogViewer()) {
        const publicTickets = window.PUBLIC_MAP_TICKETS || [];
        if (publicTickets.some((t) => ticketIdEquals(t.id, ticketId))) {
            return;
        }
    }

    // Prevent auto-zoom from running if we're selecting a ticket
    shouldAutoZoomToAllTickets = false;

    const prevSelectedTicketId = selectedTicketId;
    selectedTicketId = ticketId;

    const ticket = findTicketForMapSelection(ticketId);
    if (!ticket) return;

    if (
        isTicketHubWindowOpen() &&
        window.ticketHubModule &&
        typeof window.ticketHubModule.selectRow === 'function'
    ) {
        requestAnimationFrame(() => {
            applyTicketMapSelectionUiUpdate();
        });
        window.ticketHubModule.selectRow(ticketId, { mobileHeight: 'full' });
        return;
    }

    applyTicketMapSelectionUiUpdate();

    if (
        ticket &&
        !ticketIdEquals(prevSelectedTicketId, ticketId) &&
        ticket.ticketNumber &&
        typeof window.recordTicketView === 'function'
    ) {
        void window.recordTicketView(ticket);
    }

    if (typeof showTicketPopup === 'function') {
        showTicketPopup(ticket, { mobileHeight: 'full' });
    }

    void (async () => {
        const t = ticket;
        const mapLocal = window.map;
        if (mapLocal && t.polygon) {
            try {
                const layer = L.geoJSON(t.polygon);
                const bounds = layer.getBounds();
                if (bounds.isValid()) {
                    mapLocal.stop();
                    fitBoundsForTicketAboveDetailsPanel(mapLocal, bounds);
                }
            } catch (e) {
                /* ignore invalid geometry */
            }
        } else if (
            mapLocal &&
            t.stubMapPin &&
            Number.isFinite(Number(t.stubMapPin.lat)) &&
            Number.isFinite(Number(t.stubMapPin.lng))
        ) {
            const lat = Number(t.stubMapPin.lat);
            const lng = Number(t.stubMapPin.lng);
            mapLocal.stop();
            fitBoundsForTicketAboveDetailsPanel(mapLocal, ticketAnchorBoundsForOpenFit({ lat, lng }));
        }
    })();
}

// Aerial maps auto-load for Enhanced orgs at zoom 16+ (no Time Warp panel).
async function loadAerialMapsForTicket(_ticket) {
    return;
}

const PUBLIC_SEARCH_MIN_ZOOM = 16;

window.PUBLIC_SEARCH_MIN_ZOOM = PUBLIC_SEARCH_MIN_ZOOM;

let publicSearchGeneration = 0;

function forceClearTicketMapLayers() {
    ticketMapRenderGeneration += 1;
    if (ticketLayerGroup) {
        ticketLayerGroup.clearLayers();
    }
    if (ticketMarkerClusterGroup) {
        ticketMarkerClusterGroup.clearLayers();
    }
    ticketMapEntries = [];
    ticketMapRenderedTicketIds.clear();
    pendingAppendTickets = [];
    if (appendTicketsToMapTimer) {
        clearTimeout(appendTicketsToMapTimer);
        appendTicketsToMapTimer = null;
    }
    isRenderingTickets = false;
}

function clearPublicSearchMapOverlays() {
    if (window.aerialMapsModule && typeof window.aerialMapsModule.clearAllAerialMapsFromMap === 'function') {
        window.aerialMapsModule.clearAllAerialMapsFromMap();
    }
    if (window.photosModule && typeof window.photosModule.clearPublicSearchPhotosFromMap === 'function') {
        window.photosModule.clearPublicSearchPhotosFromMap();
    }
    if (window.layerManagerModule && typeof window.layerManagerModule.clearPublicSearchLayersFromMap === 'function') {
        window.layerManagerModule.clearPublicSearchLayersFromMap();
    }
    forceClearTicketMapLayers();
}

function openPublicCatalogTicketMapPopup(ticketId) {
    const entry = ticketMapEntries.find((e) => ticketIdEquals(e.ticketId, ticketId));
    if (!entry) return;
    if (entry.marker && typeof entry.marker.openPopup === 'function') {
        entry.marker.openPopup();
        return;
    }
    if (entry.polygon && typeof entry.polygon.openPopup === 'function') {
        entry.polygon.openPopup();
    }
}

function selectPublicCatalogTicketFromList(ticketId) {
    shouldAutoZoomToAllTickets = false;
    const publicTickets = window.PUBLIC_MAP_TICKETS || [];
    const ticket = publicTickets.find((t) => ticketIdEquals(t.id, ticketId));
    if (!ticket) return;

    selectedTicketId = ticketId;
    renderTickets();
    renderTicketList();

    const mapLocal = window.map;
    if (!mapLocal) return;

    if (ticket.polygon) {
        try {
            const layer = L.geoJSON(ticket.polygon);
            const bounds = layer.getBounds();
            if (bounds.isValid()) {
                mapLocal.stop();
                fitBoundsForTicketAboveDetailsPanel(mapLocal, bounds);
            }
        } catch (_) {
            /* ignore invalid geometry */
        }
    } else if (
        ticket.stubMapPin &&
        Number.isFinite(Number(ticket.stubMapPin.lat)) &&
        Number.isFinite(Number(ticket.stubMapPin.lng))
    ) {
        const lat = Number(ticket.stubMapPin.lat);
        const lng = Number(ticket.stubMapPin.lng);
        mapLocal.stop();
        fitBoundsForTicketAboveDetailsPanel(mapLocal, ticketAnchorBoundsForOpenFit({ lat, lng }));
    }

    requestAnimationFrame(function () {
        requestAnimationFrame(function () {
            openPublicCatalogTicketMapPopup(ticketId);
        });
    });
}

window.selectPublicCatalogTicketFromList = selectPublicCatalogTicketFromList;

function getMapBoundsBbox() {
    const map = window.map;
    if (!map) return null;
    const bounds = map.getBounds();
    if (!bounds || (typeof bounds.isValid === 'function' && !bounds.isValid())) return null;
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    return [sw.lng, sw.lat, ne.lng, ne.lat].map((n) => Number(n.toFixed(6))).join(',');
}

function getPublicSearchTimeParams() {
    const mod = window.aerialMapPanelModule;
    const c = mod && typeof mod.getTimeWarpConstraints === 'function' ? mod.getTimeWarpConstraints() : null;
    if (!c || !c.timeActive || c.startMs == null || c.endMs == null) return {};
    return {
        from: new Date(c.startMs).toISOString(),
        to: new Date(c.endMs).toISOString(),
    };
}

function updatePublicSearchResultSummary(tickets, photos, layers, aerial) {
    const el = document.getElementById('publicSearchResultSummary');
    if (!el) return;
    const t = tickets != null ? tickets : (window.PUBLIC_MAP_TICKETS || []).length;
    const p = photos != null ? photos : (window.PUBLIC_MAP_PHOTOS || []).length;
    const l = layers != null ? layers : (window.PUBLIC_MAP_LAYERS || []).length;
    const a = aerial != null ? aerial : (window.PUBLIC_MAP_AERIAL || []).length;
    if (t === 0 && p === 0 && l === 0 && a === 0) {
        el.textContent = 'No public data in this area for the selected time range.';
        return;
    }
    const parts = [];
    if (t) parts.push(`${t} ticket${t === 1 ? '' : 's'}`);
    if (p) parts.push(`${p} photo${p === 1 ? '' : 's'}`);
    if (l) parts.push(`${l} layer${l === 1 ? '' : 's'}`);
    if (a) parts.push(`${a} drone map${a === 1 ? '' : 's'}`);
    el.textContent = `Showing ${parts.join(', ')} in this area.`;
}

function clearPublicMapSearchResultsFromMap() {
    window.PUBLIC_MAP_TICKETS = [];
    window.PUBLIC_MAP_PHOTOS = [];
    window.PUBLIC_MAP_LAYERS = [];
    window.PUBLIC_MAP_AERIAL = [];
    clearPublicSearchMapOverlays();
    renderTickets({ force: true });
    if (typeof window.renderTicketList === 'function') window.renderTicketList();
    updatePublicSearchResultSummary(0, 0, 0, 0);
    if (window.aerialMapPanelModule && typeof window.aerialMapPanelModule.syncPublicAerialTimeline === 'function') {
        window.aerialMapPanelModule.syncPublicAerialTimeline();
    }
}

async function applyPublicSearchResultsToMap(searchGen) {
    if (searchGen != null && searchGen !== publicSearchGeneration) {
        return;
    }
    clearPublicSearchMapOverlays();
    renderTickets({ force: true });
    if (window.photosModule && typeof window.photosModule.renderPublicSearchPhotosOnMap === 'function') {
        window.photosModule.renderPublicSearchPhotosOnMap();
    }
    if (window.layerManagerModule && typeof window.layerManagerModule.renderPublicSearchLayersOnMap === 'function') {
        window.layerManagerModule.renderPublicSearchLayersOnMap();
    }
    if (searchGen != null && searchGen !== publicSearchGeneration) {
        return;
    }
    if (typeof window.renderTicketList === 'function') window.renderTicketList();
}

async function searchPublicDataInMapArea() {
    if (!window.authModule || !window.authModule.isAuthenticated()) return;
    if (typeof window.isCurrentOrgPublicCatalogViewer !== 'function' || !window.isCurrentOrgPublicCatalogViewer()) {
        if (typeof window.showToast === 'function') {
            window.showToast('Switch to the Public Data organization to search public map data.', 'info');
        }
        return;
    }
    const map = window.map;
    if (!map || typeof map.getZoom !== 'function' || map.getZoom() < PUBLIC_SEARCH_MIN_ZOOM) {
        if (typeof window.showToast === 'function') {
            window.showToast(`Zoom to level ${PUBLIC_SEARCH_MIN_ZOOM}+ to search public data in this area.`, 'info');
        }
        if (window.aerialMapPanelModule && typeof window.aerialMapPanelModule.updateTimeWarpUiState === 'function') {
            window.aerialMapPanelModule.updateTimeWarpUiState();
        }
        return;
    }
    const bbox = getMapBoundsBbox();
    if (!bbox) {
        if (typeof window.showToast === 'function') window.showToast('Map bounds are not ready yet.', 'error');
        return;
    }

    publicSearchGeneration += 1;
    const searchGen = publicSearchGeneration;
    clearPublicMapSearchResultsFromMap();

    try {
        const params = new URLSearchParams();
        params.set('bbox', bbox);
        params.set('types', 'tickets,photos,layers,aerial');
        const timeParams = getPublicSearchTimeParams();
        if (timeParams.from) params.set('from', timeParams.from);
        if (timeParams.to) params.set('to', timeParams.to);

        const res = await window.authModule.apiRequest(
            `${window.authModule.API_BASE}/public/map?${params.toString()}`
        );
        if (searchGen !== publicSearchGeneration) {
            return;
        }
        const tickets = res && Array.isArray(res.tickets) ? res.tickets : [];
        const photos = res && Array.isArray(res.photos) ? res.photos : [];
        const layers = res && Array.isArray(res.layers) ? res.layers : [];
        const aerial = res && Array.isArray(res.aerial) ? res.aerial : [];
        window.PUBLIC_MAP_TICKETS = tickets;
        window.PUBLIC_MAP_PHOTOS = photos;
        window.PUBLIC_MAP_LAYERS = layers;
        window.PUBLIC_MAP_AERIAL = aerial;
        await applyPublicSearchResultsToMap(searchGen);
        if (searchGen !== publicSearchGeneration) {
            return;
        }
        updatePublicSearchResultSummary(tickets.length, photos.length, layers.length, aerial.length);
        if (window.aerialMapPanelModule && typeof window.aerialMapPanelModule.syncPublicAerialTimeline === 'function') {
            window.aerialMapPanelModule.syncPublicAerialTimeline();
        }
        if (typeof window.showToast === 'function') {
            const total = tickets.length + photos.length + layers.length + aerial.length;
            window.showToast(
                total
                    ? `Loaded ${total} public item${total === 1 ? '' : 's'} in this area.`
                    : 'No public data found in this area for the selected time range.',
                total ? 'success' : 'info'
            );
        }
    } catch (e) {
        console.error('[publicMap] search:', e);
        if (typeof window.showToast === 'function') {
            window.showToast((e && e.message) || 'Failed to load public data for this area.', 'error');
        }
    }
}

window.searchPublicDataInMapArea = searchPublicDataInMapArea;
window.clearPublicMapSearchResultsFromMap = clearPublicMapSearchResultsFromMap;
window.clearPublicMapSearchResults = clearPublicMapSearchResultsFromMap;
window.updatePublicSearchResultSummary = updatePublicSearchResultSummary;

// Format date helper (user's local timezone and locale)
