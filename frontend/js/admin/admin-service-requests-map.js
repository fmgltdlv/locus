// Admin Service Requests tab — Leaflet map of ticket-linked pins

let adminSrMap = null;
let adminSrMarkers = [];
let adminSrMarkerById = new Map();
let adminSrSelectedId = null;
let adminSrMapResizeBound = false;

const ADMIN_SR_US_CENTER = [39.8283, -98.5795];
const ADMIN_SR_DEFAULT_ZOOM = 4;

function adminSrStatusColor(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'acknowledged' || s === 'resolved') return '#22c55e';
    if (s === 'complete' || s === 'read') return '#f59e0b';
    return '#3b82f6';
}

function adminSrHasValidPin(pin) {
    return (
        pin &&
        Number.isFinite(Number(pin.lat)) &&
        Number.isFinite(Number(pin.lng))
    );
}

function initAdminServiceRequestsMap() {
    if (adminSrMap || typeof L === 'undefined') return;
    const el = document.getElementById('adminServiceRequestsMap');
    if (!el) return;

    adminSrMap = L.map(el, {
        zoomControl: true,
        attributionControl: true,
    }).setView(ADMIN_SR_US_CENTER, ADMIN_SR_DEFAULT_ZOOM);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxNativeZoom: 19,
        maxZoom: 19,
    }).addTo(adminSrMap);

    if (!adminSrMapResizeBound) {
        adminSrMapResizeBound = true;
        window.addEventListener('resize', invalidateAdminServiceRequestsMap);
        window.addEventListener('orientationchange', invalidateAdminServiceRequestsMap);
    }
}

function invalidateAdminServiceRequestsMap() {
    if (!adminSrMap) return;
    requestAnimationFrame(() => {
        try {
            adminSrMap.invalidateSize({ animate: false });
        } catch (_) {
            /* ignore */
        }
    });
}

function clearAdminServiceRequestsMapMarkers() {
    adminSrMarkerById.clear();
    for (const marker of adminSrMarkers) {
        try {
            adminSrMap.removeLayer(marker);
        } catch (_) {
            /* ignore */
        }
    }
    adminSrMarkers = [];
}

function updateAdminServiceRequestsMapHint(requests) {
    const hint = document.getElementById('adminServiceRequestsMapHint');
    if (!hint) return;
    const list = Array.isArray(requests) ? requests : [];
    const withPin = list.filter((r) => adminSrHasValidPin(r.pin));
    if (!list.length) {
        hint.textContent = 'No ticket-linked locations in this list';
        hint.hidden = false;
        return;
    }
    if (!withPin.length) {
        hint.textContent = 'No ticket-linked locations in this list';
        hint.hidden = false;
        return;
    }
    if (withPin.length < list.length) {
        hint.textContent = `Showing ${withPin.length} of ${list.length} requests with ticket locations`;
        hint.hidden = false;
        return;
    }
    hint.textContent = `Showing ${withPin.length} request${withPin.length === 1 ? '' : 's'} with ticket locations`;
    hint.hidden = false;
}

function fitAdminServiceRequestsMapBounds() {
    if (!adminSrMap) return;
    const latLngs = adminSrMarkers.map((m) => m.getLatLng());
    if (!latLngs.length) {
        adminSrMap.setView(ADMIN_SR_US_CENTER, ADMIN_SR_DEFAULT_ZOOM);
        return;
    }
    if (latLngs.length === 1) {
        adminSrMap.setView(latLngs[0], 12);
        return;
    }
    const bounds = L.latLngBounds(latLngs);
    adminSrMap.fitBounds(bounds, { padding: [24, 24], maxZoom: 14 });
}

function applyAdminServiceRequestRowSelection(id) {
    document.querySelectorAll('#serviceRequestsTableBody tr.admin-sr-row').forEach((row) => {
        const rowId = Number(row.getAttribute('data-sr-id'));
        row.classList.toggle('admin-sr-row--selected', id != null && rowId === id);
    });
}

function highlightAdminServiceRequest(id) {
    initAdminServiceRequestsMap();
    if (!adminSrMap) return;
    adminSrSelectedId = id != null ? Number(id) : null;
    applyAdminServiceRequestRowSelection(adminSrSelectedId);

    for (const [markerId, marker] of adminSrMarkerById.entries()) {
        const selected = adminSrSelectedId != null && markerId === adminSrSelectedId;
        marker.setStyle({
            radius: selected ? 10 : 7,
            weight: selected ? 3 : 2,
            fillOpacity: selected ? 0.95 : 0.8,
        });
        if (selected) {
            marker.bringToFront();
        }
    }

    const marker = adminSrSelectedId != null ? adminSrMarkerById.get(adminSrSelectedId) : null;
    if (marker) {
        adminSrMap.panTo(marker.getLatLng(), { animate: true, duration: 0.35 });
    }
}

function syncAdminServiceRequestsMap(requests, selectedId) {
    initAdminServiceRequestsMap();
    if (!adminSrMap) return;

    clearAdminServiceRequestsMapMarkers();
    const list = Array.isArray(requests) ? requests : [];

    for (const item of list) {
        if (!adminSrHasValidPin(item.pin)) continue;
        const lat = Number(item.pin.lat);
        const lng = Number(item.pin.lng);
        const marker = L.circleMarker([lat, lng], {
            radius: 7,
            weight: 2,
            color: '#ffffff',
            fillColor: adminSrStatusColor(item.status),
            fillOpacity: 0.8,
        });
        marker.addTo(adminSrMap);
        marker.on('click', () => highlightAdminServiceRequest(item.id));
        adminSrMarkers.push(marker);
        adminSrMarkerById.set(Number(item.id), marker);
    }

    updateAdminServiceRequestsMapHint(list);
    fitAdminServiceRequestsMapBounds();
    invalidateAdminServiceRequestsMap();

    if (selectedId != null) {
        highlightAdminServiceRequest(selectedId);
    } else if (adminSrSelectedId != null && adminSrMarkerById.has(adminSrSelectedId)) {
        highlightAdminServiceRequest(adminSrSelectedId);
    } else {
        applyAdminServiceRequestRowSelection(null);
        adminSrSelectedId = null;
    }
}

function refreshAdminServiceRequestRowSelection() {
    applyAdminServiceRequestRowSelection(adminSrSelectedId);
}

function onAdminServiceRequestRowClick(event, id) {
    if (event && event.target && event.target.closest('button, input, a, label')) return;
    highlightAdminServiceRequest(id);
}

window.onAdminServiceRequestRowClick = onAdminServiceRequestRowClick;
window.syncAdminServiceRequestsMap = syncAdminServiceRequestsMap;
window.highlightAdminServiceRequest = highlightAdminServiceRequest;
window.invalidateAdminServiceRequestsMap = invalidateAdminServiceRequestsMap;
window.refreshAdminServiceRequestRowSelection = refreshAdminServiceRequestRowSelection;
